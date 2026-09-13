import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleAdsReadOnly, listGoogleAdsTools } from '../read-only.mjs';

// Ephemeral fixtures only: no real credentials or ad account data.
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----';
const service = { type: 'service_account', client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' };
const env = { GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', GOOGLE_ADS_SERVICE_ACCOUNT_JSON: JSON.stringify(service) };
const account = { id: '1234567890', currencyCode: 'BRL', timeZone: 'America/Sao_Paulo' };
const json = (x, status = 200, headers = {}) => new Response(JSON.stringify(x), { status, headers });
const decode = x => JSON.parse(Buffer.from(x, 'base64url'));
function fixture(options = {}) {
  const calls = [];
  const client = createGoogleAdsReadOnly({ env, authorize: async () => true, ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      if (url.endsWith('/token')) return json({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' });
      const body = JSON.parse(init.body);
      if (body.query.includes('FROM customer')) return json({ results: [{ customer: account }] });
      return json({ results: [{ campaign: { id: '19', name: 'Fixture' }, metrics: { costMicros: '9007199254740993' } }] });
    },
  });
  return { client, calls };
}

test('authentication is mandatory and fails closed before network access', async () => {
  assert.throws(() => createGoogleAdsReadOnly({ env }), /AUTHENTICATED_TRANSPORT_REQUIRED/);
  for (const authorize of [async () => false, async () => { throw Error('private-auth-data'); }, async () => 'true']) {
    const { client, calls } = fixture({ authorize });
    assert.equal((await client.callTool('google_ads_get_account')).error, 'UNAUTHORIZED');
    assert.equal(calls.length, 0);
  }
});
test('only three read tools exist; writes, arbitrary GAQL and account override are rejected', async () => {
  const { client, calls } = fixture();
  assert.equal(listGoogleAdsTools().length, 3);
  assert.ok(listGoogleAdsTools().every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  for (const name of ['mutate', 'google_ads_activate_campaign', '__proto__', 'constructor']) {
    assert.equal((await client.callTool(name)).error, 'UNSUPPORTED_READ_ONLY_TOOL');
  }
  for (const args of [{ customer_id: '9999999999' }, { query: 'SELECT *' }, { url: 'https://invalid.example' }]) {
    assert.equal((await client.callTool('google_ads_get_account', args)).error, 'INVALID_ARGUMENTS');
  }
  assert.equal(calls.length, 0);
});
test('invalid configuration stops before credentials can leave the server', async () => {
  for (const change of [
    { GOOGLE_ADS_CUSTOMER_ID: '1234567890/../other' },
    { GOOGLE_ADS_CUSTOMER_ID: '3422857277981490' },
    { GOOGLE_ADS_LOGIN_CUSTOMER_ID: 'abc' },
    { GOOGLE_ADS_API_VERSION: 'v26' },
    { GOOGLE_ADS_SERVICE_ACCOUNT_JSON: '{}' },
    { GOOGLE_ADS_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...service, token_uri: 'https://invalid.example/token' }) },
  ]) {
    const { client, calls } = fixture({ env: { ...env, ...change } });
    assert.ok((await client.callTool('google_ads_get_account')).error);
    assert.equal(calls.length, 0);
  }
});
test('service account JWT has correct signature, scope, audience and no impersonation', async () => {
  const { client, calls } = fixture({ now: () => 1800000000000 });
  const result = await client.callTool('google_ads_get_account');
  assert.equal(result.read_access_verified, true);
  assert.equal(result.write_access_verified, false);
  assert.equal(result.customer_id, '1234567890');
  const jwt = new URLSearchParams(calls[0].init.body).get('assertion').split('.');
  assert.deepEqual(decode(jwt[0]), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(jwt[1]), { iss: service.client_email, scope: 'https://www.googleapis.com/auth/adwords', aud: 'https://oauth2.googleapis.com/token', iat: 1800000000, exp: 1800003600 });
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, Buffer.from(jwt[2], 'base64url'), Buffer.from(jwt[0] + '.' + jwt[1])), true);
  assert.equal(calls[1].url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(calls[1].init.headers['developer-token'], undefined);
  assert.ok(calls.every(c => c.init.redirect === 'error' && c.init.signal instanceof AbortSignal));
  assert.ok(!JSON.stringify(result).includes('fixture-access-token'));
});
test('account identity and timezone are verified before listing campaigns', async () => {
  for (const customer of [{ ...account, id: '9999999999' }, { ...account, timeZone: 'invalid/zone' }]) {
    const { client, calls } = fixture({ fetchImpl: async url => url.endsWith('/token') ? json({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' }) : json({ results: [{ customer }] }) });
    assert.ok((await client.callTool('google_ads_list_campaigns')).error);
    assert.equal(calls.length, 2);
  }
});
test('performance keeps exact micros, account currency, and explicit date range', async () => {
  const { client, calls } = fixture();
  const result = await client.callTool('google_ads_get_performance', { start_date: '2026-09-01', end_date: '2026-09-13' });
  assert.equal(result.rows[0].metrics.costMicros, '9007199254740993');
  assert.equal(result.currency, 'BRL');
  assert.equal(result.time_zone, 'America/Sao_Paulo');
  assert.equal(result.complete, true);
  assert.match(JSON.parse(calls[2].init.body).query, /BETWEEN '2026-09-01' AND '2026-09-13'/);
});
test('invalid, reversed, oversized and injected date ranges never reach the API', async () => {
  const { client, calls } = fixture();
  for (const [start_date, end_date] of [['2026-02-30', '2026-03-01'], ['2026-09-02', '2026-09-01'], ['2026-01-01', '2026-09-01'], ["2026-09-01' OR 1=1", '2026-09-13']]) {
    assert.ok((await client.callTool('google_ads_get_performance', { start_date, end_date })).error);
  }
  assert.equal(calls.length, 0);
});
test('Google 403/429 errors are redacted and are not retried', async () => {
  for (const status of [403, 429]) {
    const { client, calls } = fixture({ fetchImpl: async url => url.endsWith('/token') ? json({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' }) : json({ error: { message: pem + 'fixture-access-token', details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }, status, { 'request-id': 'request-fixture' }) });
    const result = await client.callTool('google_ads_get_account');
    assert.equal(result.error, 'GOOGLE_ADS_FAILED');
    assert.equal(result.http_status, status);
    assert.deepEqual(result.codes, ['USER_PERMISSION_DENIED']);
    assert.equal(result.request_id, 'request-fixture');
    assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
    assert.ok(!JSON.stringify(result).includes('fixture-access-token'));
    assert.equal(calls.length, 2);
  }
});
test('network failures cannot leak request credentials', async () => {
  const { client, calls } = fixture({ fetchImpl: async () => { throw Error(pem); } });
  const result = await client.callTool('google_ads_get_account');
  assert.equal(result.error, 'OAUTH_TRANSPORT_FAILED');
  assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
  assert.equal(calls.length, 1);
});
test('token refresh is coalesced across simultaneous reads in one adapter', async () => {
  const { client, calls } = fixture();
  const results = await Promise.all([client.callTool('google_ads_get_account'), client.callTool('google_ads_get_account')]);
  assert.ok(results.every(r => r.read_access_verified));
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 1);
});
test('pagination or row caps never imply a complete inventory', async () => {
  for (const reply of [{ results: [{ campaign: { id: '1' } }], nextPageToken: 'opaque' }, { results: Array.from({ length: 1001 }, (_, id) => ({ campaign: { id: String(id) } })) }]) {
    const { client } = fixture({ fetchImpl: async (url, init) => {
      if (url.endsWith('/token')) return json({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' });
      return JSON.parse(init.body).query.includes('FROM customer') ? json({ results: [{ customer: account }] }) : json(reply);
    } });
    const result = await client.callTool('google_ads_list_campaigns');
    assert.equal(result.complete, false);
    assert.ok(result.rows.length <= 1000);
  }
});
test('reauthorization runs on every call, even when the Google token is cached', async () => {
  let allowed = true;
  const { client, calls } = fixture({ authorize: async () => allowed });
  assert.equal((await client.callTool('google_ads_get_account')).read_access_verified, true);
  allowed = false;
  assert.equal((await client.callTool('google_ads_get_account')).error, 'UNAUTHORIZED');
  assert.equal(calls.length, 2);
});
