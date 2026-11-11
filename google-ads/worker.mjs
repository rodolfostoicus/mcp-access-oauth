import OAuthProvider, { OAuthError } from '@cloudflare/workers-oauth-provider';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config as googleAdsConfig, createGoogleAdsReadOnly, listGoogleAdsTools } from './read-only.mjs';
import { createAuthHandler, allowedEmail, trustedRedirect, READ_SCOPE, WRITE_SCOPE, SCOPES, AuthFailure, page } from './auth.mjs';
import { createManagement, listManagementTools, outputSchema, MAX_MUTATION_BYTES } from './management.mjs';
export { GoogleAdsOperations } from './operations.mjs';
export { GoogleAdsLoginSessions } from './login-sessions.mjs';

const VERSION = '0.2.3';
const required = ['PUBLIC_ORIGIN', 'STOICUS_ALLOWED_EMAILS', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET'];
function secure(response, referrerPolicy = 'no-referrer', formAction = "'self'") {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Referrer-Policy', referrerPolicy);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Stoicus-Connector-Version', VERSION);
  result.headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
  return result;
}
function configuredOrigin(env) {
  if (required.some(k => typeof env[k] !== 'string' || !env[k].trim()) ||
      !env.OAUTH_KV || !env.GOOGLE_ADS_LOGIN_SESSIONS || !env.GOOGLE_ADS_AUTH_MODE) return null;
  try {
    googleAdsConfig(env);
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.origin !== env.PUBLIC_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.origin;
  } catch { return null; }
}
function failedRequest(input, error) {
  // Identify the service and stage without echoing any URL query, cookie,
  // Google code, OAuth state, operator address or upstream exception message.
  const pathname = new URL(input.url).pathname;
  const browserRoute = ['/authorize', '/callback', '/consent'].includes(pathname);
  const stage = browserRoute ? pathname.slice(1) : 'request';
  const code = error instanceof AuthFailure ? error.code : 'CONNECTOR_REQUEST_FAILED';
  const status = error instanceof AuthFailure ? error.status : 500;
  const expired = error instanceof AuthFailure && Number.isFinite(error.details?.expired_for_seconds)
    ? { expired_for_seconds: error.details.expired_for_seconds } : {};
  const report = { error: code, service: 'stoicus-google-ads', version: VERSION, stage, ...expired };
  if (!browserRoute || !input.headers.get('Accept')?.includes('text/html')) return secure(Response.json(report, { status }));
  const messages = {
    LOGIN_SESSION_EXPIRED: 'O prazo desta tentativa terminou. A conexão não foi autorizada.',
    LOGIN_SESSION_NOT_FOUND: 'O registro desta tentativa não está disponível ou já foi utilizado.',
    LOGIN_SESSION_PHASE_MISMATCH: 'Esta tentativa chegou a uma etapa diferente daquela que estava aguardando.',
    LOGIN_SESSION_MISSING: 'O navegador não enviou o cookie desta tentativa de conexão.',
    LOGIN_SESSION_INVALID: 'O vínculo desta tentativa com o navegador não pôde ser validado.',
    LOGIN_FLOW_INVALID: 'Esta página não contém uma tentativa de conexão válida.',
    OAUTH_STATE_MISMATCH: 'Esta resposta não corresponde a uma tentativa de conexão válida.',
    OPERATOR_NOT_ALLOWED: 'A conta Google selecionada não está autorizada a operar este conector.',
    GOOGLE_LOGIN_FAILED: 'Não foi possível confirmar a resposta de login recebida do Google.',
    GOOGLE_LOGIN_CANCELLED: 'O login no Google foi cancelado.',
  };
  return secure(page('Conexão Google Ads não concluída',
    `<p>${messages[code] || 'A validação desta tentativa não foi concluída.'}</p>` +
    `<p>Diagnóstico: <code>${code}</code><br>Serviço: Google Ads Stoicus<br>Versão: <strong>${VERSION}</strong><br>Etapa: <strong>${stage}</strong></p>` +
    (expired.expired_for_seconds !== undefined ? `<p>O prazo foi ultrapassado há ${expired.expired_for_seconds} segundo(s).</p>` : '') +
    '<p>Você pode compartilhar o diagnóstico acima sem enviar o endereço completo, códigos de login ou cookies.</p>' +
    '<p>Para iniciar uma nova tentativa, volte à conexão Google Ads Stoicus Secure no ChatGPT. Uma página antiga de retorno não inicia outra conexão.</p>', status));
}
async function boundedRequest(request) {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    const limit = new URL(request.url).pathname === '/mcp' ? MAX_MUTATION_BYTES + 65536 : 65536;
    if (length > limit) { await reader.cancel(); throw new AuthFailure('REQUEST_TOO_LARGE', 413); }
    chunks.push(part.value);
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: new Blob(chunks), redirect: request.redirect });
}
const apiHandler = {
  async fetch(request, env, ctx) {
    const props = ctx.props;
    const authorize = () => props && typeof props.userId === 'string' && allowedEmail(env, props.email) &&
      Array.isArray(props.scopes) && props.scopes.includes(READ_SCOPE);
    if (!authorize()) return Response.json({ error: 'OPERATOR_NOT_ALLOWED' }, { status: 403 });
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    const adapter = createGoogleAdsReadOnly({ env, authorize });
    const authorizeScope = scope => authorize() && props.scopes.includes(scope);
    const management = createManagement({ env, authorize: authorizeScope, operator: props });
    const server = new Server({ name: 'stoicus-google-ads', version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...listGoogleAdsTools().map(tool => ({
      ...tool, outputSchema, _meta: { securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE] }] },
    })), ...listManagementTools()] }));
    server.setRequestHandler(CallToolRequestSchema, async message => {
      const managed = listManagementTools().some(t=>t.name===message.params.name);
      const result = await (managed ? management : adapter).callTool(message.params.name, message.params.arguments ?? {});
      if (result.error === 'WRITE_SCOPE_REQUIRED') return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:true,
        _meta:{'mcp/www_authenticate':[`Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="${READ_SCOPE} ${WRITE_SCOPE}"`]}};
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: Boolean(result.error) };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(request); }
    finally { await server.close(); }
  },
};

export default {
  async fetch(input, env, ctx) {
    try {
      const url = new URL(input.url);
      const origin = configuredOrigin(env);
      if (url.pathname === '/health' && input.method === 'GET') return secure(Response.json({
        service: 'stoicus-google-ads', version: VERSION, mode: 'management',
        write_infrastructure_ready: Boolean(env.GOOGLE_ADS_OPERATIONS),
        login_sessions_ready: Boolean(env.GOOGLE_ADS_LOGIN_SESSIONS), browser_login_storage: 'durable_object',
        status: origin ? 'configured' : 'setup_required', google_connection_tested: false,
      }));
      if (!origin) return secure(page('Configuração pendente', '<p>O conector Google Ads está instalado e aguarda configuração pelo administrador.</p>', 503));
      if (url.origin !== origin) return secure(new Response('Origin mismatch', { status: 403 }));
      const browserOrigin = input.headers.get('Origin');
      if (browserOrigin && ![origin, 'https://chatgpt.com'].includes(browserOrigin)) return secure(new Response('Origin not allowed', { status: 403 }));
      const request = await boundedRequest(input);
      const provider = new OAuthProvider({
        apiRoute: '/mcp', apiHandler, defaultHandler: createAuthHandler({ origin }),
        authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: SCOPES, accessTokenTTL: 3600, refreshTokenTTL: 2592000,
        allowImplicitFlow: false, allowPlainPKCE: false, allowTokenExchangeGrant: false,
        clientIdMetadataDocumentEnabled: true,
        clientRegistrationCallback: ({ clientMetadata }) => {
          const uris = clientMetadata.redirect_uris;
          if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(trustedRedirect)) {
            return { code: 'invalid_redirect_uri', description: 'Only ChatGPT callback URIs are supported.' };
          }
        },
        tokenExchangeCallback: ({ props, requestedScope }) => {
          if (!props || !allowedEmail(env, props.email)) throw new OAuthError('access_denied', { description: 'Operator not allowed.' });
          return { accessTokenProps: { userId: props.userId, email: props.email,
            scopes: requestedScope.filter(s => SCOPES.includes(s) && props.scopes?.includes(s)) } };
        },
        resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin],
          scopes_supported: SCOPES, resource_name: 'Google Ads Stoicus Secure', bearer_methods_supported: ['header'] },
      });
      // Fetch serializes Origin as null on a native form POST with no-referrer.
      // The consent form needs its real Origin for CSRF checks. same-origin keeps
      // that Origin while suppressing referrers to external destinations.
      const consentPage = url.pathname === '/consent' && request.method === 'GET';
      // Browsers can apply form-action to the final OAuth redirect too. Only the
      // ChatGPT callback paths accepted by trustedRedirect are added on this page.
      const formAction = consentPage
        ? "'self' https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/"
        : "'self'";
      return secure(await provider.fetch(request, env, ctx), consentPage ? 'same-origin' : 'no-referrer', formAction);
    } catch (error) {
      return failedRequest(input, error);
    }
  },
};
