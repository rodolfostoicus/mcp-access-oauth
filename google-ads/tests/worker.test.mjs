import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { challenge, READ_SCOPE, allowedEmail } from '../auth.mjs';

// All credentials, authorization codes, users and API results in this file are fictitious.
const origin = 'https://fixture.example';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const settings = { PUBLIC_ORIGIN: origin, STOICUS_ALLOWED_EMAILS: 'operator@example.test',
  GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: 'fixture-secret', GOOGLE_ADS_REFRESH_TOKEN: 'fixture-refresh',
  GOOGLE_ADS_AUTH_MODE: 'user_oauth', GOOGLE_ADS_API_VERSION: 'v25' };
const googleCalls = [];
let googleUser = { sub: 'fixture-user-123', email: 'operator@example.test', email_verified: true };
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: new URL('../dist/worker.js', import.meta.url).pathname,
  compatibilityDate: '2026-09-13', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'], bindings: settings,
  outboundService: async request => {
    const body = request.method === 'POST' ? await request.text() : '';
    googleCalls.push({ url: request.url, body, headers: Object.fromEntries(request.headers) });
    if (request.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-google-access', token_type: 'Bearer', expires_in: 3600 });
    if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(googleUser);
    if (request.url === 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search') return Response.json({ results: [{ customer: { id: '1234567890', descriptiveName: 'Fixture', currencyCode: 'BRL', timeZone: 'America/Sao_Paulo' } }] });
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
async function begin(client) {
  const verifier = 'fixture-pkce-verifier-123456789012345678901234567890';
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: 'code',
    scope: READ_SCOPE, resource: origin + '/mcp', state: 'fixture-downstream-state',
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
  assert.deepEqual(metadata.scopes_supported, [READ_SCOPE]);
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
test('authenticated MCP lists three tools, denies account overrides, and reads only fixed Google account', async () => {
  const rpc = (method, params = {}) => send('/mcp', { ...jsonPost({ jsonrpc: '2.0', id: 7, method, params }),
    headers: { ...jsonPost({}).headers, Authorization: 'Bearer ' + tokens.access_token } });
  const before = googleCalls.length;
  const initialized = await (await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).json();
  assert.equal(initialized.result.serverInfo.name, 'stoicus-google-ads');
  const listed = await (await rpc('tools/list')).json();
  assert.equal(listed.result.tools.length, 3);
  assert.ok(listed.result.tools.every(t => t.annotations.readOnlyHint && t._meta.securitySchemes[0].scopes.includes(READ_SCOPE)));
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
