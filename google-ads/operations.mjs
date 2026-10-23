import { createGoogleAdsClient, SafeError } from './read-only.mjs';
import { allowedEmail, READ_SCOPE, WRITE_SCOPE } from './auth.mjs';
import { prepareMutation, fingerprint, safeResult, inspectTarget, mutationTargets } from './management.mjs';

// One SQLite-backed Durable Object per configured customer. It is reachable only
// through a Worker binding, never through a public HTTP route. No credentials or
// complete ad payloads are persisted. Receipts retain UUID + exact payload hash.
const ACTIVE_MS = 180000;
const MAX_INSPECTIONS = 10;
export class GoogleAdsOperations {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && /^\/receipt\/[0-9a-f-]{36}$/i.test(path)) {
      const id = path.split('/').pop();
      const r = await this.state.storage.get('request:'+id);
      return Response.json(r ? this.receipt(r) : { mode:'operation_status',request_id:id,state:'NOT_FOUND' });
    }
    if (path !== '/execute' || request.method !== 'POST') return new Response('Not found',{status:404});
    try { return Response.json(await this.execute(await request.json())); }
    catch(error) {return Response.json(safeResult(error,{mode:'management'}));}
  }
  receipt(r) {
    return { ...(r.result ?? {mode:'operation_status'}), request_id:r.request_id, state:r.state,
      created_at:r.created_at, updated_at:r.updated_at, replay:true,
      ...(r.state==='DISPATCHED'||r.state==='UNKNOWN' ? {outcome_uncertain:true,automatic_retry_allowed:false} : {}) };
  }
  async execute(job) {
    if (!job?.operator?.userId || !allowedEmail(this.env,job.operator.email) ||
        !Array.isArray(job.operator.scopes) || !job.operator.scopes.includes(READ_SCOPE) || !job.operator.scopes.includes(WRITE_SCOPE)) throw new SafeError('WRITE_SCOPE_REQUIRED');
    const client = createGoogleAdsClient({env:this.env});
    const c = client.config();
    const plan = prepareMutation(job.name,job.args,c.id);
    if (plan.preview) throw new SafeError('REAL_WRITE_REQUIRED');
    const hash = await fingerprint({customer_id:c.id,path:plan.path,body:plan.body});
    const key = 'request:'+plan.request_id;
    const now = Date.now();
    let r;
    const claimed = await this.state.storage.transaction(async tx=>{
      const previous = await tx.get(key);
      if (previous && previous.hash !== hash) return {error:'REQUEST_ID_PAYLOAD_CONFLICT',request_id:plan.request_id};
      const active = await tx.get('active');
      if (previous && !(previous.state==='VALIDATING' && (!active || active.expires<=now))) return this.receipt(previous);
      if (active && active.expires>now) return {error:'WRITE_IN_PROGRESS',retry_after_seconds:Math.ceil((active.expires-now)/1000),request_id:plan.request_id};
      const pending = await tx.get('pending:'+hash);
      if (pending && pending !== plan.request_id) return {error:'DUPLICATE_UNCERTAIN_WRITE',original_request_id:pending,automatic_retry_allowed:false};
      r = {request_id:plan.request_id,hash,state:'VALIDATING',created_at:previous?.created_at ?? new Date(now).toISOString(),updated_at:new Date(now).toISOString()};
      await tx.put(key,r);
      await tx.put('active',{request_id:plan.request_id,expires:now+ACTIVE_MS});
      return null;
    });
    if (claimed) return claimed;
    let dispatched = false;
    let committed = false;
    const persist = async (state,result) => {
      const next = {...r,state,updated_at:new Date().toISOString(),...(result ? {result} : {})};
      await this.state.storage.put(key,next);
      r = next;
    };
    try {
      const account = await client.getAccount(c);
      if (plan.native_validation) await client.api(plan.path,{...plan.body,validateOnly:true});
      const existing = plan.items.map((item,index)=>({item,index,target:item.operation.update?.resourceName ?? item.operation.remove})).filter(x=>x.target);
      const before = await Promise.all(existing.slice(0,MAX_INSPECTIONS).map(async x=>({index:x.index,...await inspectTarget(client,x.item,x.target)})));
      // Persist intent before dispatch. An interrupted/unknown POST is never
      // automatically re-issued, even if a caller supplies a different UUID.
      await this.state.storage.transaction(async tx=>{
        r = {...r,state:'DISPATCHED',updated_at:new Date().toISOString()};
        await tx.put(key,r); await tx.put('pending:'+hash,plan.request_id);
      });
      dispatched = true;
      const response = await client.api(plan.path,{...plan.body,...(plan.native_validation ? {validateOnly:false} : {})});
      if (response.partialFailureError) throw new SafeError('UNEXPECTED_PARTIAL_FAILURE');
      const targets = mutationTargets(plan,response);
      const result = {mode:'write',customer_id:c.id,request_id:plan.request_id,mutation_accepted:true,
        readback_verified:false,operations:plan.items.length,resource_names:targets,
        validation:plan.native_validation ? 'google_validated' : 'local_only_native_validation_unavailable',
        currency:account.currencyCode,time_zone:account.timeZone};
      // The receipt records Google's acknowledgement before optional read-back.
      // A later query failure must never turn a committed mutation into a retry.
      await persist('COMMITTED',result); committed = true;
      const after = await Promise.all(plan.items.slice(0,MAX_INSPECTIONS).map(async(item,index)=>({index,...await inspectTarget(client,item,targets[index],true)})));
      const compact = a=>a.map(({resource,...x})=>x);
      const final = {...result,before:compact(before),readback:compact(after),
        readback_complete:plan.items.length<=MAX_INSPECTIONS,
        readback_verified:plan.items.length<=MAX_INSPECTIONS && after.every(x=>x.verified===true)};
      await persist('COMPLETE',final);
      return {...final,state:'COMPLETE',replay:false};
    } catch(error) {
      if (committed) return {...r.result,state:'COMMITTED',readback_verified:false,readback_error:safeResult(error).error};
      const knownRejected = error instanceof SafeError && error.code==='GOOGLE_ADS_FAILED' &&
        [400,401,403,404,409,422,429].includes(error.details.http_status);
      const uncertain = dispatched && !knownRejected;
      const result = safeResult(error,{mode:'write',customer_id:c.id,request_id:plan.request_id,
        mutation_accepted:false,readback_verified:false,outcome_uncertain:uncertain,automatic_retry_allowed:false});
      await persist(uncertain?'UNKNOWN':'REJECTED',result);
      return {...result,state:r.state};
    } finally {
      await this.state.storage.transaction(async tx=>{
        const active = await tx.get('active');
        if (active?.request_id===plan.request_id) await tx.delete('active');
        if (r.state==='COMPLETE'||r.state==='COMMITTED'||r.state==='REJECTED') await tx.delete('pending:'+hash);
      });
    }
  }
}
