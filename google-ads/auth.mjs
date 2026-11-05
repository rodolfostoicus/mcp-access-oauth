// Browser login is independent of the server-side Google Ads refresh grant.
// Only opaque, short-lived session handles are stored in cookies.
export const READ_SCOPE = 'google_ads.read';
export const WRITE_SCOPE = 'google_ads.write';
export const SCOPES = [READ_SCOPE, WRITE_SCOPE];
const COOKIE = '__Host-stoicus-google-login-';
const TTL = 600;
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const encoder = new TextEncoder();

export class AuthFailure extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}
function reject(code, status) { throw new AuthFailure(code, status); }
export function allowedEmail(env, email) {
  return typeof email === 'string' && typeof env.STOICUS_ALLOWED_EMAILS === 'string' &&
    env.STOICUS_ALLOWED_EMAILS.split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
export function trustedRedirect(value) {
  return typeof value === 'string' && /^https:\/\/chatgpt\.com\/(connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]{1,200})$/.test(value);
}
function random() { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); }
export async function challenge(value) { return Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(value))).toString('base64url'); }
function cookieValue(request, id) {
  const values = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + id + '='));
  if (values.length !== 1) reject('LOGIN_SESSION_MISSING');
  const value = values[0].slice(COOKIE.length + id.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) reject('LOGIN_SESSION_INVALID');
  return value;
}
function cookie(id, value, maxAge = TTL) { return `${COOKIE}${id}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function redirect(location, session, previous) {
  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', cookie(session.id, session.secret));
  if (previous) headers.append('Set-Cookie', cookie(previous, '', 0));
  return new Response(null, { status: 302, headers });
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:17px/1.6 system-ui;background:#f3f5f7;color:#142b43;margin:0}main{max-width:620px;margin:8vh auto;padding:36px;background:white;border-radius:12px}button{background:#142b43;color:white;padding:12px 20px;border:0;border-radius:6px;font:inherit;cursor:pointer}code{overflow-wrap:anywhere}small{color:#4c5968}</style><main><h1>${escape(title)}</h1>${body}</main></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
async function save(env, value) {
  const id = random();
  const secret = random();
  await sessionOperation(env, id, { operation: 'create', value: { ...value,
    cookieHash: await challenge(secret), expires: Date.now() + TTL * 1000 } });
  return { id, secret };
}
async function sessionOperation(env, id, job) {
  if (!env.GOOGLE_ADS_LOGIN_SESSIONS) reject('LOGIN_STORAGE_UNAVAILABLE', 503);
  const stub = env.GOOGLE_ADS_LOGIN_SESSIONS.get(env.GOOGLE_ADS_LOGIN_SESSIONS.idFromName(await challenge(id)));
  const response = await stub.fetch('https://login.internal/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) });
  if (!response.ok) reject('LOGIN_STORAGE_UNAVAILABLE', 503);
  const data = await response.json();
  if (data.error) throw new AuthFailure(data.error, 400,
    Number.isFinite(data.expired_for_seconds) ? { expired_for_seconds: Math.max(0, Math.min(86400, data.expired_for_seconds)) } : {});
  return data;
}
async function session(env, request, phase, consume = false) {
  const values = new URL(request.url).searchParams.getAll(phase === 'google' ? 'state' : 'flow');
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0])) reject(phase === 'google' ? 'OAUTH_STATE_MISMATCH' : 'LOGIN_FLOW_INVALID');
  const id = values[0];
  const secret = cookieValue(request, id);
  const job = { operation: consume ? 'consume' : 'read', phase, cookieHash: await challenge(secret) };
  const { saved } = await sessionOperation(env, id, job);
  return { id, saved };
}
async function upstreamJSON(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) reject('GOOGLE_LOGIN_FAILED', 502);
    let size = 0;
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) { await reader.cancel(); reject('GOOGLE_LOGIN_FAILED', 502); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (!response.ok) reject('GOOGLE_LOGIN_FAILED', 502);
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) reject('GOOGLE_LOGIN_FAILED', 502);
    return data;
  } catch { reject('GOOGLE_LOGIN_FAILED', 502); }
  finally { clearTimeout(timer); }
}

export function createAuthHandler({ origin, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/' && request.method === 'GET') {
        return page('Google Ads Stoicus Secure', '<p>Conector privado da Stoicus para consultar, criar, modificar e remover recursos da conta Google Ads.</p><p>O acesso exige uma conta Google autorizada pela Stoicus. Cada conexão recebe as permissões exibidas no consentimento.</p>');
      }
      if (url.pathname === '/authorize' && request.method === 'GET') {
        let authRequest;
        try { authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); } catch { reject('INVALID_AUTHORIZATION_REQUEST'); }
        if (!trustedRedirect(authRequest.redirectUri) || authRequest.responseType !== 'code' ||
            authRequest.codeChallengeMethod !== 'S256' || !authRequest.codeChallenge) reject('UNSUPPORTED_OAUTH_CLIENT');
        if (!Array.isArray(authRequest.scope) || authRequest.scope.some(s => !SCOPES.includes(s))) reject('UNSUPPORTED_SCOPE');
        // Never upgrade an omitted/legacy scope to write without consent.
        if (authRequest.scope.length === 0) authRequest.scope = [READ_SCOPE];
        if (authRequest.scope.includes(WRITE_SCOPE) && !authRequest.scope.includes(READ_SCOPE)) authRequest.scope.push(READ_SCOPE);
        const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
        if (!client) reject('UNKNOWN_OAUTH_CLIENT');
        const verifier = random();
        const id = await save(env, { phase: 'google', verifier, authRequest,
          clientName: typeof client.clientName === 'string' ? client.clientName.slice(0,150) : 'ChatGPT' });
        const destination = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        destination.search = new URLSearchParams({ client_id: env.GOOGLE_ADS_CLIENT_ID, redirect_uri: origin + '/callback',
          response_type: 'code', scope: 'openid email', state: id.id, code_challenge: await challenge(verifier),
          code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' }).toString();
        return redirect(destination.toString(), id);
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        const { id, saved } = await session(env, request, 'google', true);
        if (url.searchParams.has('error')) reject('GOOGLE_LOGIN_CANCELLED');
        const code = url.searchParams.get('code');
        const issuer = url.searchParams.get('iss');
        if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096 ||
            (issuer !== null && issuer !== 'https://accounts.google.com')) reject('INVALID_GOOGLE_CALLBACK');
        const token = await upstreamJSON(fetchImpl, GOOGLE_TOKEN, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: env.GOOGLE_ADS_CLIENT_ID,
            client_secret: env.GOOGLE_ADS_CLIENT_SECRET, redirect_uri: origin + '/callback', code_verifier: saved.verifier }).toString() });
        if (typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token.access_token) ||
            typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') reject('GOOGLE_LOGIN_FAILED', 502);
        const user = await upstreamJSON(fetchImpl, GOOGLE_USERINFO, { headers: { Authorization: 'Bearer ' + token.access_token } });
        if (user.email_verified !== true || !allowedEmail(env, user.email) || typeof user.sub !== 'string' ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(user.sub)) reject('OPERATOR_NOT_ALLOWED', 403);
        const next = await save(env, { phase: 'consent', authRequest: saved.authRequest, clientName: saved.clientName,
          userId: user.sub, email: user.email.toLowerCase(), csrf: random() });
        return redirect(origin + '/consent?flow=' + next.id, next, id);
      }
      if (url.pathname === '/consent' && (request.method === 'GET' || request.method === 'POST')) {
        const { id, saved } = await session(env, request, 'consent');
        if (!allowedEmail(env, saved.email)) reject('OPERATOR_NOT_ALLOWED', 403);
        if (request.method === 'GET') {
          const write = saved.authRequest.scope.includes(WRITE_SCOPE);
          const permission = write ? 'consulte, crie, modifique e remova recursos Google Ads da Stoicus, incluindo anúncios, campanhas, orçamentos, públicos e configurações da conta. Alterações podem ativar anúncios, gerar despesas ou remover recursos' : 'consulte os dados Google Ads da Stoicus: identificação da conta, campanhas, orçamentos e resultados';
          return page('Autorizar conexão', `<p>Conta: <strong>${escape(saved.email)}</strong></p><p>Permitir que <strong>${escape(saved.clientName)}</strong> ${permission}.</p><p>Destino da autorização: <code>${escape(saved.authRequest.redirectUri)}</code></p><form method="post" action="/consent?flow=${escape(id)}"><input type="hidden" name="flow" value="${escape(id)}"><input type="hidden" name="csrf" value="${escape(saved.csrf)}"><button name="decision" value="allow">${write ? 'Autorizar gestão completa' : 'Autorizar leitura'}</button> <button name="decision" value="deny">Cancelar</button></form>`);
        }
        if (request.headers.get('Origin') !== origin) reject('CONSENT_ORIGIN_MISMATCH', 403);
        if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) reject('INVALID_CONSENT');
        const form = new URLSearchParams(await request.text());
        if (form.getAll('flow').length !== 1 || form.get('flow') !== id || form.getAll('csrf').length !== 1 || form.get('csrf') !== saved.csrf || form.getAll('decision').length !== 1 || !['allow','deny'].includes(form.get('decision'))) reject('CONSENT_CSRF_MISMATCH', 403);
        const claimed = (await session(env, request, 'consent', true)).saved;
        if (form.get('decision') !== 'allow') { const denied = page('Conexão cancelada', '<p>Você pode fechar esta janela.</p>'); denied.headers.set('Set-Cookie',cookie(id,'',0)); return denied; }
        const completed = await env.OAUTH_PROVIDER.completeAuthorization({ request: claimed.authRequest,
          userId: claimed.userId, metadata: { clientName: claimed.clientName }, scope: claimed.authRequest.scope,
          props: { userId: claimed.userId, email: claimed.email, scopes: claimed.authRequest.scope } });
        return new Response(null, { status: 302, headers: { Location: completed.redirectTo, 'Set-Cookie': cookie(id,'',0) } });
      }
      return new Response('Not found', { status: 404 });
    },
  };
}
