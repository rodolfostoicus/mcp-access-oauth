import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { challenge, READ_SCOPE, WRITE_SCOPE, SCOPES, allowedEmail } from '../auth.mjs';

// All credentials, authorization codes, users and API results in this file are fictitious.
const origin = 'https://fixture.example';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const settings = { PUBLIC_ORIGIN: origin, STOICUS_ALLOWED_EMAILS: 'operator@example.test',
  GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: 'fixture-secret', GOOGLE_ADS_REFRESH_TOKEN: 'fixture-refresh',
  GOOGLE_ADS_AUTH_MODE: 'user_oauth', GOOGLE_ADS_API_VERSION: 'v25' };
const googleCalls = [];
const adsResources = new Map();
let mutateFailure = null;
let holdMutation = null;
let nextResourceId = 100;
let googleUser = { sub: 'fixture-user-123', email: 'operator@example.test', email_verified: true };
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: new URL('../dist/worker.js', import.meta.url).pathname,
  compatibilityDate: '2026-09-13', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'], bindings: settings,
  durableObjects: { GOOGLE_ADS_OPERATIONS: { className: 'GoogleAdsOperations', useSQLite: true } },
  outboundService: async request => {
    const body = request.method === 'POST' ? await request.text() : '';
    googleCalls.push({ url: request.url, body, headers: Object.fromEntries(request.headers) });
    if (request.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-google-access', token_type: 'Bearer', expires_in: 3600 });
    if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(googleUser);
    if (request.url === 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search') {
      const query = JSON.parse(body).query;
      if (/FROM customer\b/.test(query)) return Response.json({ results: [{ customer: { resourceName:'customers/1234567890', id: '1234567890', descriptiveName: 'Fixture', currencyCode: 'BRL', timeZone: 'America/Sao_Paulo' } }] });
      const target = query.match(/resource_name = '([^']+)'/)?.[1];
      const type = query.match(/FROM (\w+)/)?.[1].replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
      return Response.json({ results: target && adsResources.has(target) ? [{[type]:adsResources.get(target)}] : [] });
    }
    if (/googleads\.googleapis\.com\/v25\/customers\/1234567890\/(googleAds|customAudiences|customerUserAccesses):mutate$/.test(request.url)) {
      const data = JSON.parse(body);
      if (data.validateOnly) return Response.json({});
      if (holdMutation) await holdMutation;
      if (mutateFailure==='unavailable') return Response.json({error:{message:'fixture-private-error'}},{status:503});
      if (mutateFailure==='denied') return Response.json({error:{details:[{errors:[{errorCode:{authorizationError:'USER_PERMISSION_DENIED'},message:'fixture-secret'}]}]}},{status:403});
      const unified = !!data.mutateOperations;
      const ops = unified ? data.mutateOperations : (data.operations ?? [data.operation]).map(op=>({[request.url.includes('customAudiences')?'customAudienceOperation':'customerUserAccessOperation']:op}));
      const results = ops.map(item=>{
        const [key,op] = Object.entries(item)[0];
        const collections = {campaignOperation:'campaigns',campaignBudgetOperation:'campaignBudgets',adGroupOperation:'adGroups',adGroupAdOperation:'adGroupAds',customAudienceOperation:'customAudiences',customerUserAccessOperation:'customerUserAccesses'};
        const resourceName = op.remove ?? op.update?.resourceName ?? `customers/1234567890/${collections[key]}/${nextResourceId++}`;
        if (op.remove) adsResources.delete(resourceName);
        else adsResources.set(resourceName,{...(adsResources.get(resourceName)??{}),...(op.create??op.update),resourceName});
        const result={resourceName};
        return unified ? {[key.replace(/Operation$/,'Result')]:result} : result;
      });
      return Response.json(unified ? {mutateOperationResponses:results} : request.url.includes('customerUserAccesses') ? {result:results[0]} : {results});
    }
    throw new Error('Unexpected outbound destination');
  },
}));
after(async () => { await mf.dispose(); });
const send = (path, init = {}) => mf.dispatchFetch(origin + path, { ...init, redirect: 'manual' });
const form = value => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(value).toString() });
const jsonPost = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(value) });
const cookie = response => response.headers.get('set-cookie').split(';')[0];
async function register(name = 'Fixture ChatGPT') {
  const response = await send('/oauth/register', jsonPost({ client_name: name, redirect_uris: [callback],
    grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }));
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function begin(client, scopes = READ_SCOPE) {
  const verifier = 'fixture-pkce-verifier-123456789012345678901234567890';
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: 'code',
    scope: scopes, resource: origin + '/mcp', state: 'fixture-downstream-state',
    code_challenge: await challenge(verifier), code_challenge_method: 'S256' });
  const response = await send('/authorize?' + query);
  assert.equal(response.status, 302, await response.clone().text());
  const google = new URL(response.headers.get('location'));
  assert.equal(google.origin + google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(google.searchParams.get('scope'), 'openid email');
  assert.equal(google.searchParams.get('redirect_uri'), origin + '/callback');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  return { verifier, query, cookie: cookie(response), google };
}
async function login(flow) {
  return send('/callback?' + new URLSearchParams({ code: 'fixture-google-code', state: flow.google.searchParams.get('state'), iss: 'https://accounts.google.com' }), { headers: { Cookie: flow.cookie } });
}
let client, flow, consentCookie, csrf, authorizationCode, authorizationExchange, tokens;

test('server denies unauthenticated access and publishes canonical OAuth discovery', async () => {
  const before = googleCalls.length;
  const denied = await send('/mcp', jsonPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(denied.status, 401, await denied.clone().text());
  assert.match(denied.headers.get('www-authenticate'), /oauth-protected-resource/);
  const metadata = await (await send('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, origin + '/mcp');
  assert.deepEqual(metadata.scopes_supported, SCOPES);
  const auth = await (await send('/.well-known/oauth-authorization-server')).json();
  assert.equal(auth.issuer, origin);
  assert.ok(auth.code_challenge_methods_supported.includes('S256'));
  assert.equal(auth.client_id_metadata_document_supported, true);
  assert.equal(googleCalls.length, before);
  assert.equal((await mf.dispatchFetch('https://other.example/mcp', jsonPost({}))).status, 403);
  for (const browserOrigin of ['null', 'https://accounts.google.com', 'https://untrusted.example']) {
    for (const path of ['/mcp', '/oauth/token', '/oauth/register', '/authorize', '/callback']) {
      const response = await send(path, { ...jsonPost({}),
        headers: { ...jsonPost({}).headers, Origin: browserOrigin } });
      assert.equal(response.status, 403, `${path}: ${browserOrigin}`);
    }
    assert.equal((await send('/mcp', { headers: { Origin: browserOrigin } })).status, 403);
  }
});
test('registration and authorization require trusted callback and S256 PKCE', async () => {
  const response = await send('/oauth/register', jsonPost({ client_name: 'Untrusted', redirect_uris: ['https://untrusted.example/callback'] }));
  assert.equal(response.status, 400);
  client = await register('<script>fixture</script>');
  flow = await begin(client);
  const query = new URLSearchParams(flow.query);
  query.set('code_challenge_method', 'plain');
  assert.equal((await send('/authorize?' + query)).status, 400);
});
test('login binds callback to the browser; tokens never appear in consent HTML', async () => {
  const before = googleCalls.length;
  assert.equal((await send('/callback?code=fixture-google-code&state=wrong', { headers: { Cookie: flow.cookie } })).status, 400);
  assert.equal((await send('/callback?code=fixture-google-code&state=' + flow.google.searchParams.get('state'))).status, 400);
  assert.equal(googleCalls.length, before);
  const loggedIn = await login(flow);
  assert.equal(loggedIn.status, 302, await loggedIn.clone().text());
  assert.equal(loggedIn.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(loggedIn.headers.get('location'), origin + '/consent');
  consentCookie = cookie(loggedIn);
  const exchange = new URLSearchParams(googleCalls[before].body);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(await challenge(exchange.get('code_verifier')), flow.google.searchParams.get('code_challenge'));
  assert.equal(exchange.get('client_secret'), settings.GOOGLE_ADS_CLIENT_SECRET);
  assert.equal(exchange.has('refresh_token'), false);
  const page = await send('/consent', { headers: { Cookie: consentCookie } });
  const html = await page.text();
  assert.ok(html.includes('&lt;script&gt;fixture&lt;/script&gt;'));
  assert.ok(!html.includes('<script>fixture'));
  assert.ok(!html.includes('fixture-google-access'));
  assert.ok(!html.includes(settings.GOOGLE_ADS_CLIENT_SECRET));
  // Native browser form POSTs under no-referrer send Origin: null (Fetch §3.2).
  // Keep a same-origin form submission identifiable without external referrers.
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const formAction = page.headers.get('content-security-policy').split(';').map(x => x.trim()).find(x => x.startsWith('form-action '));
  assert.equal(formAction, "form-action 'self' https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/");
  csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await login(flow)).status, 400);
});
test('consent requires same-origin POST and CSRF, then returns issuer and downstream state', async () => {
  const values = { csrf, decision: 'allow' };
  for (const browserOrigin of ['null', 'https://accounts.google.com', 'https://untrusted.example', 'https://chatgpt.com']) {
    const denied = await send('/consent', { ...form(values),
      headers: { ...form(values).headers, Cookie: consentCookie, Origin: browserOrigin } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('location'), null);
  }
  assert.equal((await send('/consent', { ...form(values), headers: { ...form(values).headers, Cookie: consentCookie } })).status, 403);
  assert.equal((await send('/consent', { ...form({ csrf: 'wrong', decision: 'allow' }), headers: { ...form(values).headers, Cookie: consentCookie, Origin: origin } })).status, 403);
  const approved = await send('/consent', { ...form(values), headers: { ...form(values).headers, Cookie: consentCookie, Origin: origin } });
  assert.equal(approved.status, 302, await approved.clone().text());
  assert.equal(approved.headers.get('referrer-policy'), 'no-referrer');
  assert.match(approved.headers.get('content-security-policy'), /form-action 'self';/);
  const location = new URL(approved.headers.get('location'));
  assert.equal(location.origin + location.pathname, callback);
  assert.equal(location.searchParams.get('state'), 'fixture-downstream-state');
  assert.equal(location.searchParams.get('iss'), origin);
  authorizationCode = location.searchParams.get('code');
  assert.ok(authorizationCode);
});
test('OAuth code exchange binds tokens to MCP resource', async () => {
  const values = { grant_type: 'authorization_code', code: authorizationCode, client_id: client.client_id,
    code_verifier: flow.verifier, redirect_uri: callback, resource: origin + '/mcp' };
  const wrongResource = await send('/oauth/token', form({ ...values, resource: 'https://other.example/mcp' }));
  assert.equal(wrongResource.status, 400);
  const response = await send('/oauth/token', form(values));
  assert.equal(response.status, 200, await response.clone().text());
  tokens = await response.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.notEqual(tokens.access_token, 'fixture-google-access');
  assert.equal(tokens.scope, READ_SCOPE);
  authorizationExchange = values;
});
test('authenticated MCP lists eleven tools, preserves old reads and denies old tokens every write tool', async () => {
  const rpc = (method, params = {}) => send('/mcp', { ...jsonPost({ jsonrpc: '2.0', id: 7, method, params }),
    headers: { ...jsonPost({}).headers, Authorization: 'Bearer ' + tokens.access_token } });
  const before = googleCalls.length;
  const initialized = await (await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).json();
  assert.equal(initialized.result.serverInfo.name, 'stoicus-google-ads');
  const listed = await (await rpc('tools/list')).json();
  assert.equal(listed.result.tools.length, 11);
  assert.ok(listed.result.tools.every(t => t.outputSchema && t._meta.securitySchemes[0].scopes.includes(READ_SCOPE)));
  for (const tool of listed.result.tools.filter(t=>!t.annotations.readOnlyHint)) {
    assert.equal(tool.annotations.destructiveHint,true);
    assert.deepEqual(tool._meta.securitySchemes[0].scopes,SCOPES);
    const denied=await (await rpc('tools/call',{name:tool.name,arguments:{}})).json();
    assert.equal(denied.result.structuredContent.error,'WRITE_SCOPE_REQUIRED');
    assert.match(denied.result._meta['mcp/www_authenticate'][0],/insufficient_scope/);
  }
  const override = await (await rpc('tools/call', { name: 'google_ads_get_account', arguments: { customer_id: '9999999999' } })).json();
  assert.equal(override.result.isError, true);
  assert.equal(googleCalls.length, before);
  const read = await (await rpc('tools/call', { name: 'google_ads_get_account', arguments: {} })).json();
  assert.equal(read.result.isError, false);
  assert.equal(read.result.structuredContent.customer_id, '1234567890');
  assert.equal(read.result.structuredContent.write_access_verified, false);
  assert.ok(!JSON.stringify(read).includes('fixture-google-access'));
  const refresh = new URLSearchParams(googleCalls[before].body);
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('refresh_token'), settings.GOOGLE_ADS_REFRESH_TOKEN);
  assert.equal(googleCalls[before + 1].url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
});
test('downscoped access tokens cannot inherit broader permission from the original grant', async () => {
  const response = await send('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    client_id: client.client_id, resource: origin + '/mcp', scope: 'fixture_ungranted_scope' }));
  assert.equal(response.status, 200, await response.clone().text());
  const narrowed = await response.json();
  assert.equal(narrowed.scope, '');
  const denied = await send('/mcp', { ...jsonPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    headers: { ...jsonPost({}).headers, Authorization: 'Bearer ' + narrowed.access_token } });
  assert.equal(denied.status, 403);
});
test('Google login rejects unverified or unauthorized email addresses', async () => {
  for (const user of [{ sub: 'fixture-user-123', email: 'operator@example.test', email_verified: false },
    { sub: 'fixture-user-123', email: 'outsider@example.test', email_verified: true }]) {
    googleUser = user;
    const attempt = await begin(client);
    const response = await login(attempt);
    assert.equal(response.status, 403, await response.clone().text());
    assert.equal((await response.json()).error, 'OPERATOR_NOT_ALLOWED');
  }
  assert.equal(allowedEmail({ STOICUS_ALLOWED_EMAILS: '' }, 'operator@example.test'), false);
  assert.equal(allowedEmail({ STOICUS_ALLOWED_EMAILS: 'another@example.test' }, 'operator@example.test'), false);
});

test('replaying an authorization code is rejected and revokes its issued grant', async () => {
  assert.equal((await send('/oauth/token', form(authorizationExchange))).status, 400);
  const response = await send('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    client_id: client.client_id, resource: origin + '/mcp' }));
  assert.equal(response.status, 400);
});

let managementTokens, managementClient;
const writeRpc = async(name,args={},token=managementTokens.access_token)=>{
  const response=await send('/mcp',{...jsonPost({jsonrpc:'2.0',id:99,method:'tools/call',params:{name,arguments:args}}),
    headers:{...jsonPost({}).headers,Authorization:'Bearer '+token}});
  assert.equal(response.status,200,await response.clone().text());
  return (await response.json()).result.structuredContent;
};
const realPosts=()=>googleCalls.filter(c=>/:mutate$/.test(c.url)&&!JSON.parse(c.body).validateOnly);
test('management OAuth consent grants write explicitly and preserves the repaired browser form policies',async()=>{
  googleUser={sub:'fixture-user-123',email:'operator@example.test',email_verified:true};
  managementClient=await register('Management fixture');
  const f=await begin(managementClient,SCOPES.join(' '));
  const logged=await login(f), consent=cookie(logged);
  const page=await send('/consent',{headers:{Cookie:consent}}),html=await page.text();
  assert.match(html,/Autorizar gestão completa/);assert.match(html,/remova recursos/);
  assert.equal(page.headers.get('referrer-policy'),'same-origin');
  const approved=await send('/consent',{...form({csrf:html.match(/name="csrf" value="([^"]+)"/)[1],decision:'allow'}),
    headers:{...form({}).headers,Cookie:consent,Origin:origin}});
  const location=new URL(approved.headers.get('location'));
  const response=await send('/oauth/token',form({grant_type:'authorization_code',code:location.searchParams.get('code'),
    client_id:managementClient.client_id,code_verifier:f.verifier,redirect_uri:callback,resource:origin+'/mcp'}));
  assert.equal(response.status,200,await response.clone().text());managementTokens=await response.json();
  assert.deepEqual(managementTokens.scope.split(' ').sort(),SCOPES.toSorted());
  const capabilities=await writeRpc('google_ads_get_capabilities');
  assert.equal(capabilities.resource_count,78);assert.ok(capabilities.available_scopes.includes(WRITE_SCOPE));
  const health=await(await send('/health')).json();assert.equal(health.mode,'management');assert.equal(health.write_infrastructure_ready,true);
});
test('preview validates with Google and performs zero writes; real create returns verified receipt and is replay safe',async()=>{
  const args={resource_type:'campaign',data:{name:'Fixture campaign'},request_id:'b65b3156-37cb-4436-8cfc-410f457238b3'};
  const before=realPosts().length;
  const preview=await writeRpc('google_ads_create',args);
  assert.equal(preview.validation,'google_validated');assert.equal(preview.mutation_accepted,false);assert.equal(realPosts().length,before);
  const created=await writeRpc('google_ads_create',{...args,validate_only:false});
  assert.equal(created.state,'COMPLETE',JSON.stringify(created));assert.equal(created.mutation_accepted,true);assert.equal(created.readback_verified,true);
  assert.equal(realPosts().length,before+1);assert.equal(adsResources.get(created.resource_names[0]).status,'PAUSED');
  const replay=await writeRpc('google_ads_create',{...args,validate_only:false});
  assert.equal(replay.replay,true);assert.deepEqual(replay.resource_names,created.resource_names);assert.equal(realPosts().length,before+1);
  const conflict=await writeRpc('google_ads_create',{...args,data:{name:'different'},validate_only:false});
  assert.equal(conflict.error,'REQUEST_ID_PAYLOAD_CONFLICT');assert.equal(realPosts().length,before+1);
  const receipt=await writeRpc('google_ads_get_operation',{request_id:args.request_id});assert.equal(receipt.state,'COMPLETE');
});
test('real budget update, activation and removal use exact targets with atomic requests and read-back',async()=>{
  const target='customers/1234567890/campaignBudgets/500';
  adsResources.set(target,{resourceName:target,name:'Fixture budget',amountMicros:'10000000'});
  const update=await writeRpc('google_ads_update',{resource_type:'campaign_budget',data:{resourceName:target,amountMicros:'25000000'},
    update_mask:'amount_micros',request_id:'60a07a6e-f41d-44ae-a140-ac47c3d4e608',validate_only:false});
  assert.equal(update.readback_verified,true,JSON.stringify(update));assert.equal(adsResources.get(target).name,'Fixture budget');
  const campaign='customers/1234567890/campaigns/501';adsResources.set(campaign,{resourceName:campaign,name:'Fixture',status:'PAUSED'});
  const activated=await writeRpc('google_ads_update',{resource_type:'campaign',data:{resourceName:campaign,status:'ENABLED'},update_mask:'status',request_id:'6f14c7fc-7930-4472-bb45-d466dfc57608',validate_only:false});
  assert.equal(activated.readback_verified,true);assert.equal(adsResources.get(campaign).status,'ENABLED');
  const removed=await writeRpc('google_ads_remove',{resource_type:'campaign',resource_name:campaign,request_id:'82e3188f-a679-4f51-a19f-4bcd33cae739',validate_only:false});
  assert.equal(removed.readback_verified,true);assert.equal(adsResources.has(campaign),false);
  for(const call of realPosts().filter(c=>c.url.endsWith('googleAds:mutate')))assert.equal(JSON.parse(call.body).partialFailure,false);
});
test('standalone native services are supported, including methods without validateOnly',async()=>{
  const audience=await writeRpc('google_ads_create',{resource_type:'custom_audience',data:{name:'Fixture custom'},request_id:'9c16d4d3-ea10-4c8c-a78c-8c11c0d54de5',validate_only:false});
  assert.equal(audience.mutation_accepted,true,JSON.stringify(audience));assert.match(realPosts().at(-1).url,/customAudiences:mutate$/);
  const target='customers/1234567890/customerUserAccesses/13';adsResources.set(target,{resourceName:target});
  const before=googleCalls.length;
  const preview=await writeRpc('google_ads_remove',{resource_type:'customer_user_access',resource_name:target});
  assert.equal(preview.validation,'local_only_native_validation_unavailable');
  assert.equal(googleCalls.slice(before).filter(c=>c.url.includes('customerUserAccesses:mutate')).length,0);
  const removed=await writeRpc('google_ads_remove',{resource_type:'customer_user_access',resource_name:target,request_id:'38e5d9bd-fcf5-4a9a-9c9b-ec1c3fd61f35',validate_only:false});
  assert.equal(removed.mutation_accepted,true);assert.equal(JSON.parse(realPosts().at(-1).body).validateOnly,undefined);
});
test('ambiguous upstream failures never resend, even with a new UUID; native denial is redacted',async()=>{
  const args={resource_type:'campaign',data:{name:'Fixture uncertain'},request_id:'2911179d-41fd-4b5b-8e36-a2298e7d7c7c',validate_only:false};
  mutateFailure='unavailable';const before=realPosts().length;
  const unknown=await writeRpc('google_ads_create',args);assert.equal(unknown.state,'UNKNOWN');assert.equal(unknown.outcome_uncertain,true);assert.equal(realPosts().length,before+1);
  assert.ok(!JSON.stringify(unknown).includes('fixture-private-error'));
  const replay=await writeRpc('google_ads_create',args);assert.equal(replay.state,'UNKNOWN');assert.equal(realPosts().length,before+1);
  const duplicate=await writeRpc('google_ads_create',{...args,request_id:'d99f2d5b-1a8f-41d4-9386-ead2ba4c4e79'});
  assert.equal(duplicate.error,'DUPLICATE_UNCERTAIN_WRITE');assert.equal(realPosts().length,before+1);
  mutateFailure='denied';
  const denied=await writeRpc('google_ads_create',{...args,data:{name:'Fixture denied'},request_id:'389434f7-4376-4bf0-a7ab-d908fa486c75'});
  assert.equal(denied.state,'REJECTED');assert.equal(denied.outcome_uncertain,false);assert.deepEqual(denied.codes,['USER_PERMISSION_DENIED']);assert.ok(!JSON.stringify(denied).includes('fixture-secret'));
  mutateFailure=null;
});
test('concurrent calls are serialized by the real Durable Object and replay the same UUID',async()=>{
  let release;holdMutation=new Promise(resolve=>{release=resolve;});
  const args={resource_type:'campaign',data:{name:'Fixture concurrency'},request_id:'5ec0ffeb-e18e-4c60-9b89-3a3a923537b9',validate_only:false};
  const before=realPosts().length, first=writeRpc('google_ads_create',args);
  const until=Date.now()+5000;
  while(realPosts().length===before&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  try {
    assert.equal(realPosts().length,before+1);
    const same=await writeRpc('google_ads_create',args);assert.equal(same.state,'DISPATCHED');
    const other=await writeRpc('google_ads_create',{...args,data:{name:'Fixture other'},request_id:'de3d54a2-c6f6-4ab8-a619-b3a21bd01f0b'});
    assert.equal(other.error,'WRITE_IN_PROGRESS');assert.equal(realPosts().length,before+1);
  } finally {release();holdMutation=null;}
  assert.equal((await first).state,'COMPLETE');
});
test('downscoping a management refresh token removes write permission',async()=>{
  const response=await send('/oauth/token',form({grant_type:'refresh_token',refresh_token:managementTokens.refresh_token,
    client_id:managementClient.client_id,resource:origin+'/mcp',scope:READ_SCOPE}));
  assert.equal(response.status,200);const narrowed=await response.json();assert.equal(narrowed.scope,READ_SCOPE);
  const before=realPosts().length;
  const denied=await writeRpc('google_ads_create',{resource_type:'campaign',data:{name:'Denied'}},narrowed.access_token);
  assert.equal(denied.error,'WRITE_SCOPE_REQUIRED');assert.equal(realPosts().length,before);
});
