# Implantação do Google Ads Stoicus Secure

Destino: novo Cloudflare Worker **stoicus-google-ads-mcp**. O repositório contém também o Worker Meta na raiz. A raiz de construção do Google é obrigatoriamente **google-ads**.

## 1. Criar o Worker pelo GitHub

No painel Cloudflare, abrir Workers & Pages, criar uma aplicação Worker e conectar o repositório `rodolfostoicus/mcp-access-oauth`.

| Campo | Valor |
| --- | --- |
| Nome do Worker | `stoicus-google-ads-mcp` |
| Branch de implantação inicial | `codex/google-ads-readonly-foundation` |
| Root directory | `google-ads` |
| Build command | `npm test` |
| Deploy command | `npm run deploy` |
| Caminhos observados, se configurados | `google-ads/**` |

Os comandos usam o lockfile desta pasta. O Wrangler cria a KV própria `OAUTH_KV` por provisionamento automático; não usar o ID da KV Meta. O Worker pode ser publicado inicialmente sem credenciais: retorna configuração pendente, sem acesso aos dados Google.

A branch permanece de preparação até a validação real. Quando houver integração ao main autorizada, mudar somente a branch do Worker Google. A configuração do Worker Meta permanece independente.

## 2. Configurar variáveis e secrets

No **novo Worker Google**, abrir **Settings → Variables and Secrets → Add**. As credenciais devem ser valores Secret (criptografados), e não variáveis de build, código, mensagens ou arquivos anexados.

| Nome | Tipo | Conteúdo |
| --- | --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | Secret | Client ID do cliente OAuth Google já criado |
| `GOOGLE_ADS_CLIENT_SECRET` | Secret | Secret correspondente ao mesmo cliente |
| `GOOGLE_ADS_REFRESH_TOKEN` | Secret | Novo refresh token após a revogação anterior |
| `GOOGLE_ADS_CUSTOMER_ID` | Texto | ID confirmado da conta Google Ads, dez dígitos |
| `STOICUS_ALLOWED_EMAILS` | Texto | E-mail Google autorizado a operar o conector |
| `PUBLIC_ORIGIN` | Texto | URL HTTPS exata mostrada pelo Cloudflare, sem barra final ou `/mcp` |

`GOOGLE_ADS_AUTH_MODE=user_oauth` e `GOOGLE_ADS_API_VERSION=v25` já estão no arquivo de configuração. Não é necessário fornecer chave de conta de serviço ou developer token.

Salvar e implantar as alterações no painel. Os próximos deploys usam `--keep-vars` para preservar as variáveis adicionadas pelo painel; secrets permanecem administrados pelo Cloudflare.

## 3. Atualizar o cliente OAuth Google

Na Google Auth Platform, abrir Clientes e selecionar o cliente web já utilizado. Em URIs de redirecionamento autorizados, adicionar a URL pública do Worker seguida de `/callback`. Exemplo fictício: `https://stoicus-google-ads-mcp.sua-conta.workers.dev/callback`.

Preservar o URI `https://developers.google.com/oauthplayground`. O login do conector usa `openid email`; a consulta Ads continua usando o refresh token com escopo `adwords`. Enquanto o app for externo em Testando, o operador também deve constar nos usuários de teste.

## 4. Conectar e conferir

Usar a URL do Worker seguida de `/mcp` na configuração de um conector MCP com OAuth no ChatGPT. O Google fará o login; o conector verificará o e-mail autorizado e exibirá o consentimento de leitura.

Conferir a resposta real de `google_ads_get_account`: conta, nome, BRL e fuso `America/Sao_Paulo`. Validar inventário de campanhas em seguida. Nenhuma dessas consultas ativa anúncios.

`/health` deve mostrar `configured`, mas isso confirma somente a presença das variáveis. Credencial inválida será identificada apenas na consulta Google. `OAUTH_FAILED` com `reauthorization_required=true` exige refazer a autorização e substituir o refresh token pelo painel de secrets.

## Uso contínuo

O refresh token do app externo em Testando expira em sete dias. Concluir a configuração de publicação e as informações públicas do aplicativo antes de depender de execução contínua. O token MCP tem duração de uma hora, com concessão renovável por trinta dias; são credenciais diferentes. Remover um e-mail da lista de operadores bloqueia suas próximas requisições e renovações MCP.

## Fontes oficiais

- [Workers com monorepositórios](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)
- [Secrets no painel Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Provisionamento automático de recursos](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [Autenticação MCP no ChatGPT](https://developers.openai.com/plugins/build/auth)
