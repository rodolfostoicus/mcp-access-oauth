import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../resource-catalog.json' with {type:'json'};
import { prepareMutation, fingerprint, createManagement, mutationTargets, inspectTarget } from '../management.mjs';

const customer='1234567890';
const id='b4f46db9-7243-4f08-a219-7d8a5b414815';
const prepare=(name,args)=>prepareMutation(name,args,customer);
const resourceName=type=>catalog[type].resourcePattern.replace('{customer_id}',customer).replace(/\{[^}]+\}/g,'12');

test('catalog covers all 78 native CRUD services and accepts each supported action shape',()=>{
  assert.equal(Object.keys(catalog).length,78);
  for (const [type,c] of Object.entries(catalog)) {
    for (const action of c.actions) {
      const op=action==='remove'?{remove:resourceName(type)}:{[action]:action==='update'?{resourceName:resourceName(type),name:'Fixture'}:{name:'Fixture'}};
      if(action==='update'&&c.updateMask)op.updateMask='name';
      const plan=prepare('google_ads_mutate',{operations:[{resource_type:type,operation:op}],request_id:id,validate_only:false});
      assert.equal(plan.customer_id,customer);
      assert.ok(plan.path.startsWith('/')||plan.path===':mutate');
      assert.equal(plan.body.partialFailure??false,false);
      const result={resourceName:resourceName(type)};
      const response=plan.unified?{mutateOperationResponses:[{[c.operationKey.replace(/Operation$/,'Result')]:result}]}:
        {[plan.result_field]:plan.result_field==='results'?[result]:result};
      assert.deepEqual(mutationTargets(plan,response),[resourceName(type)]);
    }
  }
});
test('native restrictions, masks and resource ownership are enforced before networking',()=>{
  const bad=[
    ['google_ads_create',{resource_type:'ad',data:{name:'x'}}],
    ['google_ads_remove',{resource_type:'asset',resource_name:resourceName('asset')}],
    ['google_ads_update',{resource_type:'campaign',data:{resourceName:resourceName('campaign'),name:'x'}}],
    ['google_ads_update',{resource_type:'campaign',data:{resourceName:resourceName('campaign'),name:'x'},update_mask:'*'}],
    ['google_ads_update',{resource_type:'campaign',data:{resourceName:resourceName('campaign'),name:'x'},update_mask:'resource_name'}],
    ['google_ads_remove',{resource_type:'campaign',resource_name:'customers/9999999999/campaigns/12'}],
    ['google_ads_remove',{resource_type:'campaign',resource_name:'customers/1234567890/adGroups/12'}],
    ['google_ads_remove',{resource_type:'campaign',resource_name:'customers/1234567890/campaigns/12/../../customers/9999999999'}],
    ['google_ads_create',{resource_type:'campaign',data:{name:'x',resource_name:'customers/9999999999/campaigns/2'}}],
    ['google_ads_create',{resource_type:'ad_group_ad',data:{ad:{resourceName:'customers/9999999999/ads/2'}}}],
    ['google_ads_create',{resource_type:'campaign_budget',data:{amountMicros:9007199254740992}}],
    ['google_ads_create',{resource_type:'campaign_budget',data:{amountMicros:1.25}}],
    ['google_ads_create',{resource_type:'campaign',data:{name:'x'},customer_id:'9999999999'}],
    ['google_ads_create',{resource_type:'campaign',data:{name:'x'},validate_only:false}],
    ['google_ads_mutate',{operations:[{resource_type:'campaign',operation:{create:{name:'x'},remove:resourceName('campaign')}}]}],
  ];
  for(const [name,args]of bad)assert.throws(()=>prepare(name,args),undefined,JSON.stringify(args));
  assert.throws(()=>prepare('google_ads_create',{resource_type:'campaign',data:JSON.parse('{"__proto__":{}}')}));
});
test('temporary IDs, atomic batches, exact monetary strings and explicit activation work',()=>{
  const plan=prepare('google_ads_mutate',{operations:[
    {resource_type:'campaign_budget',operation:{create:{resourceName:'customers/1234567890/campaignBudgets/-1',amountMicros:'10000000'}}},
    {resource_type:'campaign',operation:{create:{campaignBudget:'customers/1234567890/campaignBudgets/-1',name:'Fixture',status:'ENABLED'}}},
  ]});
  assert.equal(plan.path,'/googleAds:mutate');assert.equal(plan.body.partialFailure,false);
  assert.equal(plan.body.mutateOperations[0].campaignBudgetOperation.create.amountMicros,'10000000');
  assert.equal(plan.body.mutateOperations[1].campaignOperation.create.status,'ENABLED');
  const paused=prepare('google_ads_create',{resource_type:'campaign',data:{name:'Fixture'}});
  assert.equal(paused.items[0].operation.create.status,'PAUSED');
  assert.throws(()=>prepare('google_ads_mutate',{operations:[{resource_type:'custom_audience',operation:{create:{name:'a'}}},{resource_type:'campaign',operation:{create:{name:'b'}}}]}));
});
test('resource services outside unified mutate use their actual paths and validation support',()=>{
  const custom=prepare('google_ads_create',{resource_type:'custom_audience',data:{name:'Fixture'}});
  assert.equal(custom.path,'/customAudiences:mutate');assert.equal(custom.unified,false);assert.equal(custom.native_validation,true);
  const access=prepare('google_ads_remove',{resource_type:'customer_user_access',resource_name:resourceName('customer_user_access')});
  assert.equal(access.native_validation,false);assert.equal(access.body.validateOnly,undefined);assert.ok(access.body.operation.remove);
  const schema=prepare('google_ads_update',{resource_type:'customer_sk_ad_network_conversion_value_schema',data:{resourceName:resourceName('customer_sk_ad_network_conversion_value_schema')}});
  assert.equal(schema.items[0].operation.updateMask,undefined);
});
test('fingerprints are canonical but change when the target, action or payload changes',async()=>{
  assert.equal(await fingerprint({b:1,a:{x:2,y:3}}),await fingerprint({a:{y:3,x:2},b:1}));
  assert.notEqual(await fingerprint({create:{name:'a'}}),await fingerprint({create:{name:'b'}}));
  assert.notEqual(await fingerprint([{a:1},{b:2}]),await fingerprint([{b:2},{a:1}]));
});
test('write-scope denial and malformed inputs cause no outbound requests',async()=>{
  let calls=0;
  const env={GOOGLE_ADS_CUSTOMER_ID:customer,GOOGLE_ADS_AUTH_MODE:'user_oauth',GOOGLE_ADS_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_ADS_CLIENT_SECRET:'secret',GOOGLE_ADS_REFRESH_TOKEN:'refresh'};
  const a=createManagement({env,authorize:s=>s==='google_ads.read',fetchImpl:()=>{calls++;throw Error('network');}});
  assert.equal((await a.callTool('google_ads_create',{resource_type:'campaign',data:{name:'a'}})).error,'WRITE_SCOPE_REQUIRED');
  assert.equal((await a.callTool('google_ads_query',{query:'DELETE FROM campaign'})).error,'GAQL_SELECT_REQUIRED');
  assert.equal((await a.callTool('google_ads_query',{query:'SELECT campaign.id FROM campaign',customer_id:'other'})).error,'INVALID_ARGUMENTS');
  assert.equal(calls,0);
});
test('new GAQL and metadata tools preserve pagination and route credentials only to fixed Google endpoints',async()=>{
  const calls=[];
  const env={GOOGLE_ADS_CUSTOMER_ID:customer,GOOGLE_ADS_AUTH_MODE:'user_oauth',GOOGLE_ADS_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_ADS_CLIENT_SECRET:'secret',GOOGLE_ADS_REFRESH_TOKEN:'refresh'};
  const a=createManagement({env,authorize:()=>true,fetchImpl:async(url,init)=>{
    calls.push({url,body:JSON.parse(init.headers['Content-Type']==='application/json'?init.body:'{}')});
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture',token_type:'Bearer',expires_in:3600});
    return Response.json({results:[{value:'9007199254740993'}],nextPageToken:'fixture-next'});
  }});
  const query='SELECT campaign.id FROM campaign';
  const page=await a.callTool('google_ads_query',{query,page_token:'fixture-previous'});
  assert.equal(page.complete,false);assert.equal(page.next_page_token,'fixture-next');assert.equal(page.rows[0].value,'9007199254740993');
  assert.deepEqual(calls.at(-1).body,{query,pageToken:'fixture-previous'});
  assert.equal(calls.at(-1).url,'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
  await a.callTool('google_ads_search_fields',{query:'SELECT name, selectable WHERE name LIKE \'campaign.%\''});
  assert.equal(calls.at(-1).url,'https://googleads.googleapis.com/v25/googleAdsFields:search');
});
test('a successful identity/name read does not falsely verify nested creative or targeting fields',async()=>{
  const target=resourceName('campaign');
  const result=await inspectTarget({api:async()=>({results:[{campaign:{resourceName:target,name:'Fixture',status:'PAUSED'}}]})},
    {resource_type:'campaign',operation:{create:{name:'Fixture',status:'PAUSED',geoTargetTypeSetting:{positiveGeoTargetType:'PRESENCE'}}}},target,true);
  assert.equal(result.verified,false);assert.deepEqual(result.unverified_fields,['geoTargetTypeSetting']);
});
