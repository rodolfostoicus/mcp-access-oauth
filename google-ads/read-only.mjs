// Internal Google Ads adapter. Mount only behind authenticated MCP transport.
// Fixed Google transport; only server code can choose API paths. No logging.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ORIGIN = 'https://googleads.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const MAX_ROWS = 1000;
const MAX_BYTES = 2_000_000;
const ID = /^\d{10}$/;
const OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
const encoder = new TextEncoder();

export class SafeError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
function fail(code) { throw new SafeError(code); }
function record(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function customerId(raw) {
  if (typeof raw !== 'string' || !/^(\d{10}|\d{3}-\d{3}-\d{4})$/.test(raw)) fail('INVALID_CUSTOMER_ID');
  return raw.replaceAll('-', '');
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function encodedJSON(value) { return base64url(encoder.encode(JSON.stringify(value))); }
function day(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE');
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) fail('INVALID_DATE');
  return ms;
}
function validateArgs(args, required) {
  if (!record(args) || Object.keys(args).some(k => !required.includes(k)) || required.some(k => !(k in args))) fail('INVALID_ARGUMENTS');
}
export function config(env) {
  const id = customerId(env.GOOGLE_ADS_CUSTOMER_ID);
  const login = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? customerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) : null;
  // Version pinned to the current major release; upgrades require review.
  if (env.GOOGLE_ADS_API_VERSION && env.GOOGLE_ADS_API_VERSION !== 'v25') fail('UNSUPPORTED_API_VERSION');
  const authMode = env.GOOGLE_ADS_AUTH_MODE ?? 'service_account';
  if (authMode === 'user_oauth') {
    const clientId = env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET;
    const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN;
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}\.apps\.googleusercontent\.com$/.test(clientId) ||
        typeof clientSecret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(clientSecret) ||
        typeof refreshToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(refreshToken)) fail('INVALID_USER_OAUTH_CONFIGURATION');
    return { id, login, authMode, clientId, clientSecret, refreshToken };
  }
  if (authMode !== 'service_account') fail('UNSUPPORTED_AUTH_MODE');
  let account;
  try { account = JSON.parse(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON); } catch { fail('SERVICE_ACCOUNT_NOT_CONFIGURED'); }
  if (!record(account) || account.type !== 'service_account' ||
      typeof account.client_email !== 'string' || !/^[a-z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(account.client_email) ||
      typeof account.private_key !== 'string' || !account.private_key.startsWith('-----BEGIN PRIVATE KEY-----') ||
      (account.token_uri !== undefined && account.token_uri !== TOKEN_URL)) fail('INVALID_SERVICE_ACCOUNT_CONFIGURATION');
  return { id, login, authMode, account };
}

const schemas = {
  google_ads_get_account: { description: 'Read the configured Google Ads account, currency and timezone.', properties: {}, required: [] },
  google_ads_list_campaigns: { description: 'Read up to 1000 non-removed campaigns and their budget configuration. Incomplete inventories are flagged.', properties: {}, required: [] },
  google_ads_get_performance: {
    description: 'Read campaign metrics for an inclusive period of at most 93 days, using account-local dates. Values are in account currency; costMicros is an exact integer string.',
    properties: { start_date: { type: 'string', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' }, end_date: { type: 'string', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' } },
    required: ['start_date', 'end_date'],
  },
};
export function listGoogleAdsTools() {
  return Object.entries(schemas).map(([name, value]) => ({
    name, description: value.description,
    inputSchema: { type: 'object', properties: structuredClone(value.properties), required: [...value.required], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));
}

/**
 * authorize() MUST validate the current caller in the hosting MCP transport.
 * It receives no caller-controlled identity and must throw or return false on denial.
 * Create one adapter per authenticated transport/session. Never expose env to tools.
 * fetchImpl/now are dependency injection for offline tests, not tool arguments.
 */
export function createGoogleAdsClient({ env, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now }) {
  // Snapshot configuration so an instance cannot reuse a cached token for new credentials.
  const settings = Object.freeze({ ...env });
  let cachedToken = null;
  let refreshInFlight = null;

  async function requestJSON(url, options, stage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        fail('UPSTREAM_REDIRECT_REJECTED');
      }
      const reader = response.body?.getReader();
      if (!reader) fail('EMPTY_UPSTREAM_RESPONSE');
      let bytes = 0;
      let text = '';
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); fail('UPSTREAM_RESPONSE_TOO_LARGE'); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let data;
      try { data = JSON.parse(text); } catch { fail('INVALID_UPSTREAM_JSON'); }
      if (!response.ok) {
        // Do not return raw Google error messages, headers, body, assertions or keys.
        const codes = [];
        const fieldPaths = [];
        for (const detail of (Array.isArray(data?.error?.details) ? data.error.details : [])) {
          for (const error of (Array.isArray(detail?.errors) ? detail.errors : [])) {
            const elements = error?.location?.fieldPathElements;
            if (Array.isArray(elements) && elements.length <= 30 && elements.every(x=>typeof x.fieldName==='string' && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(x.fieldName) && (x.index===undefined || Number.isSafeInteger(x.index)))) {
              fieldPaths.push(elements.map(x=>x.fieldName+(x.index===undefined?'':`[${x.index}]`)).join('.'));
            }
            for (const code of Object.values(record(error?.errorCode) ? error.errorCode : {})) {
              if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)) codes.push(code);
            }
          }
        }
        const requestId = response.headers.get('request-id');
        const oauthError = stage === 'OAUTH' && OAUTH_ERRORS.has(data?.error) ? data.error : null;
        throw new SafeError(stage + '_FAILED', {
          http_status: response.status,
          codes: [...new Set(codes)].slice(0, 10),
          ...(fieldPaths.length ? { field_paths: [...new Set(fieldPaths)].slice(0,10) } : {}),
          ...(oauthError ? { oauth_error: oauthError, ...(oauthError === 'invalid_grant' ? { reauthorization_required: true } : {}) } : {}),
          ...(requestId && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ? { request_id: requestId } : {}),
        });
      }
      if (!record(data)) fail('INVALID_UPSTREAM_RESPONSE');
      return data;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : stage + '_TRANSPORT_FAILED');
    } finally { clearTimeout(timer); }
  }

  async function accessToken(c) {
    if (cachedToken && cachedToken.expires > now() + 60000) return cachedToken.value;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let body;
      if (c.authMode === 'user_oauth') {
        body = new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId,
          client_secret: c.clientSecret, refresh_token: c.refreshToken });
      } else {
        let key;
        try {
          const raw = c.account.private_key.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
          const bytes = Uint8Array.from(atob(raw), x => x.charCodeAt(0));
          key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        } catch { fail('INVALID_SERVICE_ACCOUNT_KEY'); }
        const issued = Math.floor(now() / 1000);
        const input = encodedJSON({ alg: 'RS256', typ: 'JWT' }) + '.' + encodedJSON({
          iss: c.account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600,
        });
        const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input));
        const assertion = input + '.' + base64url(new Uint8Array(signature));
        body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
      }
      const result = await requestJSON(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }, 'OAUTH');
      if (typeof result.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(result.access_token) ||
          result.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) ||
          result.expires_in <= 60 || result.expires_in > 3600) fail('INVALID_OAUTH_RESPONSE');
      cachedToken = { value: result.access_token, expires: now() + result.expires_in * 1000 };
      return cachedToken.value;
    })();
    try { return await refreshInFlight; } finally { refreshInFlight = null; }
  }

  async function search(c, query) {
    const token = await accessToken(c);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (c.login) headers['login-customer-id'] = c.login;
    let data;
    try {
      data = await requestJSON(`${API_ORIGIN}/v25/customers/${c.id}/googleAds:search`, {
        method: 'POST', headers, body: JSON.stringify({ query }),
      }, 'GOOGLE_ADS');
    } catch (error) {
      if (error instanceof SafeError && error.details.http_status === 401) cachedToken = null;
      throw error; // No automatic retries, including 429/rate limits.
    }
    // Google may omit repeated fields when they are empty.
    const rows = data.results ?? [];
    if (!Array.isArray(rows) || rows.some(row => !record(row))) fail('INVALID_SEARCH_RESPONSE');
    return { rows: rows.slice(0, MAX_ROWS), complete: !data.nextPageToken && rows.length <= MAX_ROWS };
  }

  async function getAccount(c) {
    const result = await search(c, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 2');
    const a = result.rows[0]?.customer;
    if (!result.complete || result.rows.length !== 1 || !record(a) || String(a.id) !== c.id ||
        typeof a.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(a.currencyCode) || typeof a.timeZone !== 'string') fail('ACCOUNT_READBACK_UNVERIFIED');
    try { new Intl.DateTimeFormat('en', { timeZone: a.timeZone }); } catch { fail('INVALID_ACCOUNT_TIMEZONE'); }
    return a;
  }

  async function api(path, body, fields = false) {
    const c = config(settings);
    const token = await accessToken(c);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (c.login) headers['login-customer-id'] = c.login;
    const target = fields ? '/googleAdsFields:search' : `/customers/${c.id}${path}`;
    return requestJSON(`${API_ORIGIN}/v25${target}`, { method: 'POST', headers, body: JSON.stringify(body) }, 'GOOGLE_ADS');
  }
  return Object.freeze({ config: () => config(settings), search, getAccount, api });
}

export function createGoogleAdsReadOnly({ env, authorize, fetchImpl, now }) {
  if (typeof authorize !== 'function') fail('AUTHENTICATED_TRANSPORT_REQUIRED');
  const { config: getConfig, search, getAccount } = createGoogleAdsClient({ env, fetchImpl, now });
  return Object.freeze({
    listTools: listGoogleAdsTools,
    async callTool(name, args = {}) {
      try {
        let allowed = false;
        try { allowed = (await authorize()) === true; } catch { /* deny with no auth details */ }
        if (!allowed) fail('UNAUTHORIZED');
        if (!Object.hasOwn(schemas, name)) fail('UNSUPPORTED_READ_ONLY_TOOL');
        validateArgs(args, schemas[name].required);
        if (name === 'google_ads_get_performance') {
          const interval = (day(args.end_date) - day(args.start_date)) / 86400000;
          if (interval < 0 || interval > 92) fail('DATE_RANGE_MUST_BE_1_TO_93_DAYS');
        }
        const c = getConfig();
        if (!ID.test(c.id)) fail('INVALID_CUSTOMER_ID');
        const account = await getAccount(c);
        const common = { mode: 'read_only', customer_id: c.id, currency: account.currencyCode, time_zone: account.timeZone, read_access_verified: true, write_access_verified: false };
        if (name === 'google_ads_get_account') return { ...common, account };
        let query;
        if (name === 'google_ads_list_campaigns') {
          query = 'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.start_date, campaign.end_date, campaign.bidding_strategy_type, campaign.geo_target_type_setting.positive_geo_target_type, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != REMOVED ORDER BY campaign.id LIMIT 1001';
        } else {
          query = `SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${args.start_date}' AND '${args.end_date}' ORDER BY metrics.cost_micros DESC LIMIT 1001`;
        }
        const result = await search(c, query);
        return { ...common, ...result, ...(name === 'google_ads_get_performance' ? { start_date: args.start_date, end_date: args.end_date } : {}) };
      } catch (error) {
        return { mode: 'read_only', read_access_verified: false, write_access_verified: false,
          error: error instanceof SafeError ? error.code : 'INTERNAL_FAILURE',
          ...(error instanceof SafeError ? error.details : {}),
        };
      }
    },
  });
}
