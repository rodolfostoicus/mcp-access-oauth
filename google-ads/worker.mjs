import OAuthProvider, { OAuthError } from '@cloudflare/workers-oauth-provider';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleAdsReadOnly, listGoogleAdsTools } from './read-only.mjs';
import { createAuthHandler, allowedEmail, trustedRedirect, READ_SCOPE, AuthFailure, page } from './auth.mjs';

const VERSION = '0.1.0';
const required = ['PUBLIC_ORIGIN', 'STOICUS_ALLOWED_EMAILS', 'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'];
function secure(response) {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return result;
}
function configuredOrigin(env) {
  if (required.some(k => typeof env[k] !== 'string' || !env[k].trim()) || !env.OAUTH_KV || env.GOOGLE_ADS_AUTH_MODE !== 'user_oauth') return null;
  try {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.origin !== env.PUBLIC_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.origin;
  } catch { return null; }
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
    if (length > 65536) { await reader.cancel(); throw new AuthFailure('REQUEST_TOO_LARGE', 413); }
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
    const server = new Server({ name: 'stoicus-google-ads', version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listGoogleAdsTools().map(tool => ({
      ...tool, _meta: { securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE] }] },
    })) }));
    server.setRequestHandler(CallToolRequestSchema, async message => {
      const result = await adapter.callTool(message.params.name, message.params.arguments ?? {});
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
        service: 'stoicus-google-ads', version: VERSION, mode: 'read_only',
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
        scopesSupported: [READ_SCOPE], accessTokenTTL: 3600, refreshTokenTTL: 2592000,
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
            scopes: requestedScope.filter(s => s === READ_SCOPE) } };
        },
        resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin],
          scopes_supported: [READ_SCOPE], resource_name: 'Google Ads Stoicus Secure', bearer_methods_supported: ['header'] },
      });
      return secure(await provider.fetch(request, env, ctx));
    } catch (error) {
      return secure(Response.json({ error: error instanceof AuthFailure ? error.code : 'CONNECTOR_REQUEST_FAILED' },
        { status: error instanceof AuthFailure ? error.status : 500 }));
    }
  },
};
