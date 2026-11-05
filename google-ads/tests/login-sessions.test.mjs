import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { challenge, READ_SCOPE, WRITE_SCOPE } from '../auth.mjs';

// This suite uses only fictitious identities, grants, codes and credentials.
// The Worker bundle, SQLite Durable Objects and OAuth provider run in workerd.
const origin = 'https://login-fixture.example';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const prefix = '__Host-stoicus-google-login-';
const settings = {
  PUBLIC_ORIGIN: origin, STOICUS_ALLOWED_EMAILS: 'operator@example.test',
  GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: 'fixture-secret', GOOGLE_ADS_REFRESH_TOKEN: 'fixture-refresh',
  GOOGLE_ADS_AUTH_MODE: 'user_oauth', GOOGLE_ADS_API_VERSION: 'v25',
};
const calls = [];
let upstreamFailure = false;
function options(withLoginBinding = true) {
  return convertV4MiniflareOptions({
    modules: true, scriptPath: new URL('../dist/worker.js', import.meta.url).pathname,
    compatibilityDate: '2026-09-13', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'], bindings: settings,
    durableObjects: {
      GOOGLE_ADS_OPERATIONS: { className: 'GoogleAdsOperations', useSQLite: true },
      ...(withLoginBinding ? { GOOGLE_ADS_LOGIN_SESSIONS: { className: 'GoogleAdsLoginSessions', useSQLite: true } } : {}),
    },
    outboundService: async request => {
      const body = request.method === 'POST' ? await request.text() : '';
      calls.push({ url: request.url, body });
      if (request.url === 'https://oauth2.googleapis.com/token') {
        if (upstreamFailure) return Response.json({ error: 'fixture_failure' }, { status: 503 });
        return Response.json({ access_token: 'fixture-google-access', token_type: 'Bearer', expires_in: 3600 });
      }
      if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ sub: 'fixture-user-123', email: 'operator@example.test', email_verified: true });
      }
      throw new Error('Unexpected outbound destination in login regression fixture');
    },
  });
}
const mf = new Miniflare(options());
after(async () => { await mf.dispose(); });
const send = (path, init = {}) => mf.dispatchFetch(origin + path, { ...init, redirect: 'manual' });
const jsonPost = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
function cookieHeaders(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') || '').split(/,(?=\s*__Host-)/);
}
class BrowserJar {
  values = new Map();
  absorb(response) {
    for (const item of cookieHeaders(response)) {
      const pair = item.split(';')[0].trim();
      const at = pair.indexOf('=');
      const key = pair.slice(0, at), value = pair.slice(at + 1);
      if (/Max-Age=0(?:;|$)/i.test(item) || !value) this.values.delete(key);
      else this.values.set(key, value);
    }
  }
  header() { return [...this.values].map(([key, value]) => `${key}=${value}`).join('; '); }
  selected(flow) { return `${prefix}${flow}=${this.values.get(prefix + flow)}`; }
}
async function denied(response) {
  assert.ok(response.status >= 400 && response.status < 500, `${response.status}: ${await response.clone().text()}`);
  assert.equal(response.headers.get('location'), null);
}
let clientPromise;
async function client() {
  clientPromise ??= (async () => {
    const response = await send('/oauth/register', jsonPost({ client_name: 'Login Regression Fixture', redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }));
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  })();
  return clientPromise;
}
async function begin(jar = new BrowserJar(), state = 'fixture-downstream-state', scopes = READ_SCOPE) {
  const registered = await client();
  const verifier = 'fixture-pkce-verifier-123456789012345678901234567890';
  const params = new URLSearchParams({ client_id: registered.client_id, redirect_uri: callback, response_type: 'code',
    resource: origin + '/mcp', state, scope: scopes, code_challenge: await challenge(verifier), code_challenge_method: 'S256' });
  const response = await send('/authorize?' + params, { headers: { Cookie: jar.header() } });
  assert.equal(response.status, 302, await response.clone().text());
  jar.absorb(response);
  const google = new URL(response.headers.get('location'));
  assert.equal(google.origin + google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(google.searchParams.get('scope'), 'openid email');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  const id = google.searchParams.get('state');
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  const nonce = jar.values.get(prefix + id);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(nonce, id, 'State must not itself be the browser-binding cookie secret');
  const setCookie = cookieHeaders(response).find(x => x.startsWith(prefix + id + '='));
  for (const property of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(property), property);
  return { id, nonce, jar, google, verifier, state, scopes, registered };
}
function callbackPath(flow, overrides = {}) {
  return '/callback?' + new URLSearchParams({ code: 'fixture-google-code', state: flow.id, iss: 'https://accounts.google.com', ...overrides });
}
async function googleLogin(flow) {
  const response = await send(callbackPath(flow), { headers: { Cookie: flow.jar.header() } });
  assert.equal(response.status, 302, await response.clone().text());
  flow.jar.absorb(response);
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, origin + '/consent');
  const consentID = destination.searchParams.get('flow');
  assert.match(consentID, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(consentID, flow.id);
  assert.ok(flow.jar.values.has(prefix + consentID));
  assert.ok(!flow.jar.values.has(prefix + flow.id), 'Only the completed callback cookie should be cleared');
  return { ...flow, consentID, consentPath: destination.pathname + destination.search };
}
async function consentPage(flow) {
  const response = await send(flow.consentPath, { headers: { Cookie: flow.jar.header() } });
  assert.equal(response.status, 200, await response.clone().text());
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const hiddenFlow = html.match(/name="flow" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  assert.equal(hiddenFlow, flow.consentID);
  assert.ok(!html.includes('fixture-secret'));
  assert.ok(!html.includes('fixture-google-access'));
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  return { ...flow, csrf };
}
function approve(flow, overrides = {}) {
  const params = overrides.params ?? new URLSearchParams({ flow: flow.consentID, csrf: flow.csrf, decision: 'allow', ...overrides.values });
  return send(overrides.path ?? flow.consentPath, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: overrides.cookie ?? flow.jar.header(), Origin: overrides.origin ?? origin },
    body: params.toString(),
  });
}
function verifyGrant(response, state) {
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, callback);
  assert.equal(destination.searchParams.get('state'), state);
  assert.ok(destination.searchParams.get('code'));
  return destination.searchParams.get('code');
}
const tokenCalls = () => calls.filter(x => x.url === 'https://oauth2.googleapis.com/token');
async function sessionJob(id, value) {
  const namespace = await mf.getDurableObjectNamespace('GOOGLE_ADS_LOGIN_SESSIONS');
  const stub = namespace.get(namespace.idFromName(await challenge(id)));
  const response = await stub.fetch('https://login.internal/session', jsonPost(value));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('fresh login reaches consent immediately using SQLite and leaves browser state out of Workers KV', async () => {
  const flow = await begin();
  const kv = await mf.getKVNamespace('OAUTH_KV');
  assert.equal((await kv.list({ prefix: 'google-login:' })).keys.length, 0);
  const before = tokenCalls().length;
  const ready = await consentPage(await googleLogin(flow));
  assert.equal(tokenCalls().length, before + 1);
  const exchange = new URLSearchParams(tokenCalls().at(-1).body);
  assert.equal(await challenge(exchange.get('code_verifier')), flow.google.searchParams.get('code_challenge'));
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.has('refresh_token'), false);
  assert.equal((await kv.list({ prefix: 'google-login:' })).keys.length, 0);
  verifyGrant(await approve(ready), flow.state);
  assert.ok((await kv.list()).keys.length > 0, 'Original provider KV must still contain registered client/grant data');
});

test('two browser tabs retain separate cookies and downstream state when completed out of order', async () => {
  const jar = new BrowserJar();
  const a = await begin(jar, 'fixture-tab-A', READ_SCOPE);
  const b = await begin(jar, 'fixture-tab-B', READ_SCOPE + ' ' + WRITE_SCOPE);
  assert.notEqual(a.id, b.id);
  assert.equal(jar.values.size, 2);
  const readyB = await consentPage(await googleLogin(b));
  assert.ok(jar.values.has(prefix + a.id));
  const readyA = await consentPage(await googleLogin(a));
  const grantB = await approve(readyB);
  jar.absorb(grantB);
  verifyGrant(grantB, 'fixture-tab-B');
  assert.ok(jar.values.has(prefix + readyA.consentID), 'Approving B cannot clear the cookie for A');
  const grantA = await approve(readyA);
  verifyGrant(grantA, 'fixture-tab-A');
  const code = new URL(grantA.headers.get('location')).searchParams.get('code');
  const exchanged = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: a.registered.client_id,
      redirect_uri: callback, resource: origin + '/mcp', code_verifier: a.verifier }).toString() });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  assert.equal((await exchanged.json()).scope, READ_SCOPE, 'A must not inherit write scope from tab B');
});

test('concurrent duplicate callbacks consume their session once and exchange exactly one Google code', async () => {
  const flow = await begin();
  const before = tokenCalls().length;
  const responses = await Promise.all([0, 1].map(() => send(callbackPath(flow), { headers: { Cookie: flow.jar.header() } })));
  assert.equal(responses.filter(x => x.status === 302).length, 1);
  await denied(responses.find(x => x.status !== 302));
  assert.equal(tokenCalls().length, before + 1);
});

test('concurrent consent submissions issue exactly one authorization code', async () => {
  const ready = await consentPage(await googleLogin(await begin()));
  const responses = await Promise.all([approve(ready), approve(ready)]);
  assert.equal(responses.filter(x => x.status === 302).length, 1);
  verifyGrant(responses.find(x => x.status === 302), ready.state);
  await denied(responses.find(x => x.status !== 302));
  await denied(await approve(ready));
});

test('invalid state and browser cookies cannot exchange a code or consume a valid flow', async () => {
  const flow = await begin();
  const before = tokenCalls().length;
  const wrong = 'x'.repeat(43);
  for (const [path, cookie] of [
    [callbackPath(flow, { state: 'invalid' }), flow.jar.header()],
    [callbackPath(flow, { state: wrong }), flow.jar.header()],
    [callbackPath(flow), ''],
    [callbackPath(flow), `${prefix}${flow.id}=${wrong}`],
    [callbackPath(flow), `${flow.jar.header()}; ${flow.jar.header()}`],
    [callbackPath(flow) + '&state=' + flow.id, flow.jar.header()],
  ]) await denied(await send(path, { headers: { Cookie: cookie } }));
  assert.equal(tokenCalls().length, before);
  await consentPage(await googleLogin(flow));
  assert.equal(tokenCalls().length, before + 1);
});

test('consent rejects wrong origins, CSRF, swapped flows and duplicated parameters without consuming the grant', async () => {
  const ready = await consentPage(await googleLogin(await begin()));
  const other = await consentPage(await googleLogin(await begin()));
  const before = calls.length;
  for (const badOrigin of ['null', 'https://untrusted.example', 'https://chatgpt.com']) {
    await denied(await approve(ready, { origin: badOrigin }));
  }
  await denied(await approve(ready, { values: { csrf: 'wrong' } }));
  await denied(await approve(ready, { values: { flow: other.consentID } }));
  await denied(await approve(ready, { path: other.consentPath }));
  await denied(await approve(ready, { cookie: other.jar.header() }));
  await denied(await approve(ready, { path: ready.consentPath + '&flow=' + ready.consentID }));
  const duplicated = new URLSearchParams({ flow: ready.consentID, csrf: ready.csrf, decision: 'allow' });
  duplicated.append('csrf', ready.csrf);
  await denied(await approve(ready, { params: duplicated }));
  assert.equal(calls.length, before, 'Malformed consent must not call Google');
  verifyGrant(await approve(ready), ready.state);
});

test('failed upstream exchange cannot replay a consumed callback', async () => {
  const flow = await begin();
  const before = tokenCalls().length;
  upstreamFailure = true;
  try {
    const failed = await send(callbackPath(flow), { headers: { Cookie: flow.jar.header() } });
    assert.ok(failed.status >= 400);
  } finally { upstreamFailure = false; }
  assert.equal(tokenCalls().length, before + 1);
  await denied(await send(callbackPath(flow), { headers: { Cookie: flow.jar.header() } }));
  assert.equal(tokenCalls().length, before + 1);
});

test('real SQLite login object distinguishes wrong phase, wrong browser secret and consumed state', async () => {
  const flow = await begin();
  const cookieHash = await challenge(flow.nonce);
  const before = calls.length;
  const wrongPhase = await sessionJob(flow.id, { operation: 'read', cookieHash, phase: 'consent' });
  assert.equal(wrongPhase.error, 'LOGIN_SESSION_PHASE_MISMATCH');
  const wrongSecret = await sessionJob(flow.id, { operation: 'consume', cookieHash: 'x'.repeat(43), phase: 'google' });
  assert.equal(wrongSecret.error, 'LOGIN_SESSION_INVALID');
  const found = await sessionJob(flow.id, { operation: 'read', cookieHash, phase: 'google' });
  assert.equal(found.saved.phase, 'google');
  const claimed = await Promise.all([0, 1].map(() => sessionJob(flow.id, { operation: 'consume', cookieHash, phase: 'google' })));
  assert.equal(claimed.filter(x => x.saved).length, 1);
  assert.equal(claimed.filter(x => x.error === 'LOGIN_SESSION_NOT_FOUND').length, 1);
  await denied(await send(callbackPath(flow), { headers: { Cookie: flow.jar.header() } }));
  assert.equal(calls.length, before);
});

test('expired SQLite login cannot exchange a Google code, including after alarm cleanup', async () => {
  const flow = await begin();
  const cookieHash = await challenge(flow.nonce);
  const claimed = await sessionJob(flow.id, { operation: 'consume', cookieHash, phase: 'google' });
  assert.ok(claimed.saved);
  const created = await sessionJob(flow.id, { operation: 'create', value: { ...claimed.saved, expires: Date.now() + 100 } });
  assert.equal(created.created, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  const before = calls.length;
  const response = await send(callbackPath(flow), { headers: { Cookie: flow.jar.header() } });
  await denied(response);
  const failure = await response.json();
  assert.ok(['LOGIN_SESSION_EXPIRED', 'LOGIN_SESSION_NOT_FOUND'].includes(failure.error), failure.error);
  assert.equal(calls.length, before);
});

test('login binding absent fails closed and never starts upstream login', async () => {
  const missing = new Miniflare(options(false));
  try {
    const before = calls.length;
    const health = await (await missing.dispatchFetch(origin + '/health')).json();
    assert.equal(health.login_sessions_ready, false);
    assert.equal(health.status, 'setup_required');
    const response = await missing.dispatchFetch(origin + '/authorize?client_id=fixture', { redirect: 'manual' });
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal(response.headers.get('location'), null);
    assert.equal(calls.length, before);
  } finally { await missing.dispose(); }
});

function verifyDiagnosticHeaders(response) {
  assert.equal(response.headers.get('x-stoicus-connector-version'), '0.2.3');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

test('JSON login diagnostics identify the deployed version and callback stage without echoing request values', async () => {
  const before = calls.length;
  const privateCode = 'fixture-private-callback-code';
  const privateState = 'fixture-private-malformed-state';
  const privateEmail = 'fixture-private-email@example.test';
  const params = new URLSearchParams({ code: privateCode, state: privateState, email: privateEmail });
  const response = await send('/callback?' + params, { headers: { Accept: 'application/json', Cookie: 'fixture-private-cookie=fixture-private-cookie-value' } });
  await denied(response);
  verifyDiagnosticHeaders(response);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.text();
  const data = JSON.parse(body);
  assert.equal(data.error, 'OAUTH_STATE_MISMATCH');
  assert.equal(data.service, 'stoicus-google-ads');
  assert.equal(data.version, '0.2.3');
  assert.equal(data.stage, 'callback');
  for (const value of [privateCode, privateState, privateEmail, 'fixture-private-cookie-value']) assert.ok(!body.includes(value), value);
  assert.equal(calls.length, before);
});

test('browser login errors render bounded Portuguese diagnostics with version and stage but no sensitive query or cookie data', async () => {
  const before = calls.length;
  const cases = [
    ['/callback?state=fixture-private-state&code=fixture-private-code&email=fixture-private-email', 'callback', 'OAUTH_STATE_MISMATCH'],
    ['/consent?csrf=fixture-private-csrf&code=fixture-private-code', 'consent', 'LOGIN_FLOW_INVALID'],
  ];
  for (const [path, stage, error] of cases) {
    const response = await send(path, { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Cookie: 'fixture-private-cookie=fixture-private-cookie-value' } });
    await denied(response);
    verifyDiagnosticHeaders(response);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /lang="pt-BR"/);
    assert.match(html, /0\.2\.3/);
    assert.ok(html.includes(stage));
    assert.ok(html.includes(error));
    for (const value of ['fixture-private-state', 'fixture-private-code', 'fixture-private-email', 'fixture-private-csrf', 'fixture-private-cookie-value', 'fixture-secret', 'fixture-refresh', 'fixture-google-access']) assert.ok(!html.includes(value), value);
  }
  assert.equal(calls.length, before);
});

test('missing consent flow has the same safe JSON diagnostic metadata and production health exposes the matching version header', async () => {
  const before = calls.length;
  const response = await send('/consent', { headers: { Accept: 'application/json' } });
  await denied(response);
  verifyDiagnosticHeaders(response);
  const diagnostic = await response.json();
  assert.equal(diagnostic.error, 'LOGIN_FLOW_INVALID');
  assert.equal(diagnostic.service, 'stoicus-google-ads');
  assert.equal(diagnostic.version, '0.2.3');
  assert.equal(diagnostic.stage, 'consent');
  const health = await send('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-stoicus-connector-version'), '0.2.3');
  assert.equal((await health.json()).version, '0.2.3');
  assert.equal(calls.length, before);
});
