import catalog from './resource-catalog.json' with { type: 'json' };
import { createGoogleAdsClient, SafeError } from './read-only.mjs';
import { READ_SCOPE, WRITE_SCOPE } from './auth.mjs';

export const MAX_OPERATIONS = 100;
export const MAX_MUTATION_BYTES = 6_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, details = {}) => { throw new SafeError(code, details); };
const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const get = (o, path) => path.split('.').reduce((a,k) => a?.[camel(k)], o);
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const resourceType = { type: 'string', enum: Object.keys(catalog).sort() };
const dataSchema = { type: 'object', additionalProperties: true, description: 'Native Google Ads REST resource in camelCase. Use exact strings for int64/micros values.' };
const controls = {
  request_id: { type: 'string', format: 'uuid', description: 'Stable UUID for one logical write. Required for a real write; reuse the same UUID after a timeout, never substitute another.' },
  validate_only: { type: 'boolean', default: true, description: 'true previews without modifying Google. false validates then performs the authorized write.' },
};
const definitions = {
  google_ads_get_capabilities: { read: true, description: 'List all supported resource types, native create/update/remove capabilities, limits and current connection scopes.', inputSchema: schema({}) },
  google_ads_query: { read: true, description: 'Run read-only GAQL SELECT against the configured account. Supports all queryable resources, metrics and pagination. Preserve the query when using next_page_token.',
    inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 20000 }, page_token: { type: 'string', maxLength: 16384 } }, ['query']) },
  google_ads_search_fields: { read: true, description: 'Query GoogleAdsField metadata (SELECT without FROM) to discover valid resource fields, types, selectable/filterable attributes and enums.',
    inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 20000 }, page_token: { type: 'string', maxLength: 16384 } }, ['query']) },
  google_ads_get_operation: { read: true, description: 'Read the durable receipt for an exact write UUID. This returns the historical result, not the present resource state. Never automatically resubmit an UNKNOWN operation.',
    inputSchema: schema({ request_id: controls.request_id }, ['request_id']) },
  google_ads_create: { read: false, description: 'Create a resource in the configured account. For a new ad use ad_group_ad with nested ad. Creates with a delivery status default to PAUSED; explicit ENABLED is supported. Google permissions and native restrictions apply. Use validate_only=false to execute an authorized creation.',
    inputSchema: schema({ resource_type: resourceType, data: dataSchema, ...controls }, ['resource_type','data']) },
  google_ads_update: { read: false, description: 'Update selected fields of an existing account-owned resource, including budgets, bids, audiences and PAUSED/ENABLED status. data.resourceName and update_mask identify the exact target and fields. Omitted values in the mask are cleared by Google. Use validate_only=false for an authorized change.',
    inputSchema: schema({ resource_type: resourceType, data: dataSchema, update_mask: { type: 'string', minLength: 1, maxLength: 4000 }, ...controls }, ['resource_type','data']) },
  google_ads_remove: { read: false, description: 'Remove an exact account-owned resource using its native remove operation. Google removals may be irreversible and historical records may remain. Asset/ad types without remove support must be managed through their associations (e.g. ad_group_ad). Use validate_only=false only for an authorized removal.',
    inputSchema: schema({ resource_type: resourceType, resource_name: { type: 'string', minLength: 1, maxLength: 1000 }, ...controls }, ['resource_type','resource_name']) },
  google_ads_mutate: { read: false, description: 'Create/update/remove up to 100 resources atomically with native REST operations and negative temporary IDs. Each item has resource_type and operation containing exactly one of create/update/remove, plus updateMask for updates and supported policy fields. Cross-resource batches use GoogleAdsService; non-unified services require a single resource type. partialFailure is always false. Preview by default; validate_only=false executes the authorized batch. Never retry an uncertain write with a new UUID.',
    inputSchema: schema({ operations: { type: 'array', minItems: 1, maxItems: MAX_OPERATIONS, items: schema({ resource_type: resourceType, operation: dataSchema }, ['resource_type','operation']) }, ...controls }, ['operations']) },
};
export const outputSchema = { type: 'object', properties: {
  mode: { type: 'string' }, error: { type: 'string' }, customer_id: { type: 'string' },
  state: { type: 'string' }, mutation_accepted: { type: 'boolean' },
  readback_verified: { type: 'boolean' }, request_id: { type: 'string' },
}, additionalProperties: true };
export function listManagementTools() {
  return Object.entries(definitions).map(([name, d]) => ({ name, description: d.description,
    inputSchema: structuredClone(d.inputSchema), outputSchema,
    annotations: { readOnlyHint: d.read, destructiveHint: !d.read, idempotentHint: d.read, openWorldHint: true },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: d.read ? [READ_SCOPE] : [READ_SCOPE, WRITE_SCOPE] }] },
  }));
}
export function safeResult(error, extra = {}) {
  return { ...extra, error: error instanceof SafeError ? error.code : 'INTERNAL_FAILURE',
    ...(error instanceof SafeError ? error.details : {}) };
}
function keys(args, allowed, required = []) {
  if (!record(args) || Object.keys(args).some(k => !allowed.includes(k)) || required.some(k => !(k in args))) fail('INVALID_ARGUMENTS');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function validateJSON(value, customer, depth = 0) {
  if (depth > 35) fail('JSON_TOO_DEEP');
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) fail('USE_EXACT_INTEGER_STRINGS');
  if (Array.isArray(value)) { for (const x of value) validateJSON(x, customer, depth + 1); }
  else if (record(value)) {
    for (const [k,v] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(k)) fail('INVALID_JSON_KEY');
      if (k.includes('_')) fail('USE_REST_CAMEL_CASE_FIELDS');
      if (k === 'resourceName' && (typeof v !== 'string' || !v.startsWith(`customers/${customer}/`) && v !== `customers/${customer}`)) fail('RESOURCE_OUTSIDE_CONFIGURED_ACCOUNT');
      if (/Micros$/.test(k) && !(typeof v === 'string' && /^-?\d+$/.test(v) || Number.isSafeInteger(v))) fail('INVALID_MICROS_VALUE');
      validateJSON(v, customer, depth + 1);
    }
  }
}
function resourcePattern(type, customer) {
  const pattern = catalog[type].resourcePattern;
  return new RegExp('^' + pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{customer_id}', customer).replace(/\{[^}]+\}/g, '[A-Za-z0-9_~-]+') + '$');
}
function targetAllowed(type, target, customer) {
  if (typeof target !== 'string' || target.length > 1000 || !resourcePattern(type, customer).test(target)) fail('INVALID_RESOURCE_NAME', { resource_type: type });
}
export function prepareMutation(name, args, customer) {
  const d = definitions[name];
  if (!d || d.read) fail('UNSUPPORTED_MUTATION_TOOL');
  keys(args, Object.keys(d.inputSchema.properties), d.inputSchema.required);
  const preview = args.validate_only ?? true;
  if (typeof preview !== 'boolean') fail('INVALID_VALIDATE_ONLY');
  if ((!preview || args.request_id !== undefined) && !UUID.test(args.request_id ?? '')) fail('STABLE_REQUEST_UUID_REQUIRED');
  let items;
  if (name === 'google_ads_mutate') items = args.operations;
  else {
    const action = name.slice('google_ads_'.length);
    const operation = action === 'remove' ? { remove: args.resource_name } : { [action]: args.data };
    if (action === 'update' && args.update_mask !== undefined) operation.updateMask = args.update_mask;
    items = [{ resource_type: args.resource_type, operation }];
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_OPERATIONS) fail('INVALID_OPERATION_COUNT');
  if (new TextEncoder().encode(JSON.stringify(items)).length > MAX_MUTATION_BYTES) fail('MUTATION_TOO_LARGE');
  items = structuredClone(items);
  for (const item of items) {
    keys(item, ['resource_type','operation'], ['resource_type','operation']);
    const c = catalog[item.resource_type];
    if (!c || !Object.hasOwn(catalog,item.resource_type)) fail('UNSUPPORTED_RESOURCE_TYPE');
    const op = item.operation;
    keys(op, ['create','update','remove',...(c.updateMask ? ['updateMask'] : []),...c.operationExtraFields]);
    const actions = ['create','update','remove'].filter(a => Object.hasOwn(op,a));
    if (actions.length !== 1 || !c.actions.includes(actions[0])) fail('UNSUPPORTED_RESOURCE_OPERATION', { resource_type: item.resource_type, allowed_actions: c.actions });
    const action = actions[0];
    if (action === 'remove') {
      if (Object.keys(op).length !== 1) fail('INVALID_REMOVE_OPERATION');
      targetAllowed(item.resource_type, op.remove, customer);
    } else {
      if (!record(op[action])) fail('INVALID_RESOURCE_DATA');
      if (action === 'update') {
        targetAllowed(item.resource_type, op.update.resourceName, customer);
        if (c.updateMask && (typeof op.updateMask !== 'string' || op.updateMask.length > 4000 ||
          !/^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)*(?:,[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)*)*$/.test(op.updateMask) ||
          op.updateMask.split(',').some(x => ['resource_name','resourceName','id'].includes(x)))) fail('EXPLICIT_UPDATE_MASK_REQUIRED');
      } else {
        if ('updateMask' in op) fail('INVALID_CREATE_OPERATION');
        if (op.create.resourceName !== undefined) targetAllowed(item.resource_type, op.create.resourceName, customer);
        if (['campaign','ad_group','ad_group_ad','asset_group'].includes(item.resource_type) && op.create.status === undefined) op.create.status = 'PAUSED';
      }
      validateJSON(op[action], customer);
      for (const k of c.operationExtraFields) if (op[k] !== undefined) validateJSON(op[k], customer);
    }
  }
  const types = new Set(items.map(x=>x.resource_type));
  const unified = items.every(x=>catalog[x.resource_type].unified);
  if (!unified && types.size !== 1) fail('RESOURCE_TYPES_REQUIRE_SEPARATE_BATCHES');
  const first = catalog[items[0].resource_type];
  if (!unified && first.operationField === 'operation' && items.length !== 1) fail('SERVICE_REQUIRES_SINGLE_OPERATION');
  const path = unified ? '/googleAds:mutate' : first.path;
  const body = unified ? { mutateOperations: items.map(x=>({ [catalog[x.resource_type].operationKey]: x.operation })), partialFailure: false, responseContentType: 'MUTABLE_RESOURCE' }
    : { [first.operationField]: first.operationField === 'operation' ? items[0].operation : items.map(x=>x.operation),
      ...(first.partialFailure ? { partialFailure: false } : {}), ...(first.responseContentType ? { responseContentType: 'MUTABLE_RESOURCE' } : {}) };
  return { customer_id: customer, request_id: args.request_id, preview, items, path, body,
    native_validation: unified || first.validateOnly, unified, result_field: unified ? 'mutateOperationResponses' : first.resultField };
}
function validatedQuery(args) {
  keys(args, ['query','page_token'], ['query']);
  if (typeof args.query !== 'string' || args.query.length > 20000 || !/^\s*SELECT\s/i.test(args.query)) fail('GAQL_SELECT_REQUIRED');
  if (args.page_token !== undefined && (typeof args.page_token !== 'string' || args.page_token.length > 16384)) fail('INVALID_PAGE_TOKEN');
  return { query: args.query, ...(args.page_token ? { pageToken: args.page_token } : {}) };
}
export function createManagement({ env, authorize, fetchImpl, operator }) {
  const client = createGoogleAdsClient({ env, fetchImpl });
  return {
    async callTool(name, args = {}) {
      try {
        const d = definitions[name];
        if (!d) fail('UNSUPPORTED_TOOL');
        if (!(await authorize(d.read ? READ_SCOPE : WRITE_SCOPE))) fail(d.read ? 'UNAUTHORIZED' : 'WRITE_SCOPE_REQUIRED');
        const c = client.config();
        if (name === 'google_ads_get_capabilities') {
          keys(args,[]);
          return { mode: 'management', customer_id: c.id, available_scopes: [READ_SCOPE,...(await authorize(WRITE_SCOPE) ? [WRITE_SCOPE] : [])],
            resource_count: Object.keys(catalog).length, resources: catalog, max_operations: MAX_OPERATIONS,
            note: 'Native Google permissions, API access level and resource restrictions apply. Specialized non-CRUD actions (uploads, recommendation application, experiment promotion, reservation actions) are not provided by these mutation tools.' };
        }
        if (name === 'google_ads_query' || name === 'google_ads_search_fields') {
          const body = validatedQuery(args);
          const result = await client.api('/googleAds:search', body, name === 'google_ads_search_fields');
          const rows = result.results ?? [];
          if (!Array.isArray(rows)) fail('INVALID_SEARCH_RESPONSE');
          return { mode: 'read_only', customer_id: c.id, rows, complete: !result.nextPageToken,
            ...(result.nextPageToken ? { next_page_token: result.nextPageToken } : {}), field_mask: result.fieldMask ?? null };
        }
        if (name === 'google_ads_get_operation') {
          keys(args,['request_id'],['request_id']);
          if (!UUID.test(args.request_id)) fail('INVALID_REQUEST_ID');
          if (!env.GOOGLE_ADS_OPERATIONS) fail('OPERATION_STORE_NOT_CONFIGURED');
          return (await env.GOOGLE_ADS_OPERATIONS.get(env.GOOGLE_ADS_OPERATIONS.idFromName(c.id)).fetch('https://operations.internal/receipt/'+args.request_id)).json();
        }
        const plan = prepareMutation(name, args, c.id);
        if (plan.preview) {
          await client.getAccount(c);
          if (plan.native_validation) await client.api(plan.path,{...plan.body,validateOnly:true});
          return { mode: 'validate_only', customer_id: c.id, mutation_accepted: false,
            validation: plan.native_validation ? 'google_validated' : 'local_only_native_validation_unavailable',
            proposed: plan.items, operations: plan.items.length };
        }
        if (!env.GOOGLE_ADS_OPERATIONS) fail('OPERATION_STORE_NOT_CONFIGURED');
        const stub = env.GOOGLE_ADS_OPERATIONS.get(env.GOOGLE_ADS_OPERATIONS.idFromName(c.id));
        return (await stub.fetch('https://operations.internal/execute', { method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ name,args,operator }) })).json();
      } catch (error) { return safeResult(error,{mode:'management'}); }
    },
  };
}

function readSpec(item, target) {
  const type = item.resource_type;
  const op = item.operation;
  const fields = new Set(['resource_name']);
  if (op.updateMask) op.updateMask.split(',').forEach(x=>fields.add(x.split('.').map(snake).join('.')));
  else if (op.create) for (const [k,v] of Object.entries(op.create)) if (['string','number','boolean'].includes(typeof v) && k !== 'resourceName') fields.add(snake(k));
  if (op.remove && ['campaign','ad_group','ad_group_ad','ad_group_criterion','campaign_criterion','asset_group','shared_set','user_list','conversion_action','asset_set'].includes(type)) fields.add('status');
  const selected = [...fields].map(f=>type+'.'+f);
  return { fields: [...fields], query: `SELECT ${selected.join(', ')} FROM ${type} WHERE ${type}.resource_name = '${target}' LIMIT 2` };
}
export async function inspectTarget(client, item, target, verify = false) {
  try {
    const {fields,query} = readSpec(item,target);
    const data = await client.api('/googleAds:search',{query});
    const rows = data.results ?? [];
    if (!Array.isArray(rows) || data.nextPageToken) fail('READBACK_INCOMPLETE');
    if (item.operation.remove && verify && rows.length === 0) return {resource_name:target,verified:true,removed:true};
    const resource = rows[0]?.[camel(item.resource_type)];
    if (rows.length !== 1 || !resource || resource.resourceName !== target) return {resource_name:target,verified:false,error:'TARGET_NOT_FOUND'};
    if (!verify) return {resource_name:target,found:true,resource};
    if (item.operation.remove) return {resource_name:target,verified:resource.status==='REMOVED',resource};
    const desired = item.operation.update ?? item.operation.create;
    const checked = fields.filter(x=>x!=='resource_name');
    const differences = checked.filter(f=>{
      const expected = get(desired,f), actual = get(resource,f);
      // Proto3 omits default fields. Do not claim a cleared/default value verified.
      if (expected === undefined) return true;
      return canonical(actual) !== canonical(expected) && !(typeof actual === 'string' && typeof expected === 'number' && actual === String(expected));
    });
    const unverifiedFields = opFieldsNotSelected(item.operation,checked);
    return {resource_name:target,verified:checked.length>0 && differences.length===0 && unverifiedFields.length===0,
      checked_fields:checked,unverified_fields:unverifiedFields,differences,resource};
  } catch (error) {return safeResult(error,{resource_name:target,verified:false});}
}
function opFieldsNotSelected(operation, checked) {
  // Nested create fields are not necessarily selectable as a whole in GAQL.
  // An identity/name check must not claim that nested ad/targeting data matched.
  if (!operation.create) return [];
  return Object.keys(operation.create).filter(k=>k!=='resourceName'&&!checked.includes(snake(k)));
}
export function mutationTargets(plan, data) {
  let responses = data[plan.result_field];
  if (!Array.isArray(responses)) responses = responses ? [responses] : [];
  if (responses.length !== plan.items.length) fail('MUTATION_RESPONSE_UNVERIFIED');
  return responses.map((r,i)=>{
    const result = plan.unified ? r[catalog[plan.items[i].resource_type].operationKey.replace(/Operation$/,'Result')] : r;
    const target = result?.resourceName;
    targetAllowed(plan.items[i].resource_type,target,plan.customer_id);
    const expected = plan.items[i].operation.update?.resourceName ?? plan.items[i].operation.remove;
    if (expected && target !== expected) fail('MUTATION_TARGET_MISMATCH');
    return target;
  });
}
