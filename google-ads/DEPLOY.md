# Implantação do Google Ads Stoicus Secure

Destino: Cloudflare Worker existente **stoicus-google-ads-mcp**. O repositório contém também o Worker Meta na raiz. A raiz de construção do Google é obrigatoriamente **google-ads**.

## Atualização 0.2.0 — gestão completa de recursos

Esta atualização foi autorizada pela responsável para habilitar leitura, criação, alteração e remoção no plugin existente. Preservar Worker, URL, plugin, cliente OAuth e secrets atuais. Não criar outro conector.

1. Publicar o commit testado em `ads-google` e na branch de revisão do PR 41. A integração GitHub/Cloudflare usa `google-ads` como raiz, `npm test` como build e `npm run deploy` como deploy.
2. A migração `google-ads-operations-v1` cria automaticamente a classe SQLite `GoogleAdsOperations` e o binding `GOOGLE_ADS_OPERATIONS`. Preservar `OAUTH_KV` e as variáveis existentes.
3. Conferir o check **Workers Builds: stoicus-google-ads-mcp** e a versão 0.2.0 em `/health`. `write_infrastructure_ready` deve ser `true`; o health não comprova permissão de escrita no Google Ads.
4. No plugin existente, usar **Atualizar** para carregar as 11 ferramentas. Conceder o novo escopo `google_ads.write` pelo fluxo OAuth e escolher **Autorizar gestão completa**. Uma conexão antiga de leitura pode continuar consultando; uma tentativa de usar ferramenta de escrita gera desafio de escopo insuficiente.
5. Na conversa com o plugin selecionado, executar `google_ads_get_capabilities` e conferir os escopos `google_ads.read` e `google_ads.write`. Essa conferência não modifica anúncios. A primeira tarefa real de gestão deve usar os objetos e parâmetros autorizados e conferir o retorno Google.

O novo escopo precisa do consentimento OAuth do operador; alterar o código não amplia silenciosamente concessões antigas. A permissão de escrita Google continua limitada ao papel da pessoa, ao nível de acesso da API e aos métodos suportados pelo Google. O catálogo em `resource-catalog.json` descreve 78 tipos e suas ações nativas; não representa todas as funções da interface web Google Ads.

Os testes de gravação desta atualização usam um Google simulado. A publicação habilita ferramentas; não executa criação, remoção, ativação nem alteração de orçamento na conta real.

## Instalação inicial (histórico)

## 1. Criar o Worker pelo GitHub

No painel Cloudflare, abrir Workers & Pages, criar uma aplicação Worker e conectar o repositório `rodolfostoicus/mcp-access-oauth`.

| Campo | Valor |
| --- | --- |
| Nome do Worker | `stoicus-google-ads-mcp` |
| Production branch | `ads-google` |
| Root directory | `google-ads` |
| Build command | `npm test` |
| Deploy command | `npm run deploy` |
| Caminhos observados, se configurados | `google-ads/**` |

Se a tela de criação não mostrar a branch, configurar `Path=google-ads` e concluir o cadastro. A tentativa inicial pode falhar porque o Cloudflare seleciona `main`, onde o código Google ainda não foi integrado. No novo Worker, abrir **Settings → Builds → Branch control**, selecionar **ads-google** e salvar. Um novo commit nessa branch inicia o build correto. Manter Builds for non-production branches desmarcado.

Os comandos usam o lockfile desta pasta. O Wrangler cria a KV própria `OAUTH_KV` por provisionamento automático; não usar o ID da KV Meta. O Worker pode ser publicado inicialmente sem credenciais: retorna configuração pendente, sem acesso aos dados Google.

A branch `ads-google` é usada para implantação. A revisão continua no PR 41, cuja branch é `codex/google-ads-readonly-foundation`; manter as duas no mesmo commit revisado ao publicar atualizações. Quando houver integração ao main autorizada, mudar somente a branch do Worker Google. A configuração do Worker Meta permanece independente.

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

Preservar o URI `https://developers.google.com/oauthplayground`. O login do conector usa `openid email`; o acesso Ads continua usando o refresh token com escopo `adwords`. Enquanto o app for externo em Testando, o operador também deve constar nos usuários de teste.

## 4. Conectar e conferir

Usar a URL do Worker seguida de `/mcp` na configuração de um conector MCP com OAuth no ChatGPT. O Google fará o login; o conector verificará o e-mail autorizado e exibirá o consentimento dos escopos solicitados: leitura ou gestão completa.

Conferir a resposta real de `google_ads_get_account`: conta, nome, BRL e fuso `America/Sao_Paulo`. Validar inventário de campanhas em seguida. Nenhuma dessas consultas ativa anúncios.

`/health` deve mostrar `configured`, mas isso confirma somente a presença das variáveis. Credencial inválida será identificada apenas na consulta Google. `OAUTH_FAILED` com `reauthorization_required=true` exige refazer a autorização e substituir o refresh token pelo painel de secrets.

## Uso contínuo

O refresh token do app externo em Testando expira em sete dias. Concluir a configuração de publicação e as informações públicas do aplicativo antes de depender de execução contínua. O token MCP tem duração de uma hora, com concessão renovável por trinta dias; são credenciais diferentes. Remover um e-mail da lista de operadores bloqueia suas próximas requisições e renovações MCP.

## Correção 0.1.1 — origem no consentimento OAuth

A versão 0.1.0 enviava `Referrer-Policy: no-referrer` também na página de consentimento. Pelo [padrão Fetch, seção 3.2](https://fetch.spec.whatwg.org/#origin-header), essa política faz o envio nativo do formulário apresentar `Origin: null`, causando `Origin not allowed`. A versão 0.1.1 usa `Referrer-Policy: same-origin` exclusivamente na resposta GET de `/consent`, preservando a origem do formulário e omitindo referências para destinos externos. Todas as demais respostas continuam com `no-referrer`.

Permanecem as mesmas verificações de origem, cliente, PKCE, state/cookie, sessão, e-mail autorizado e consentimento POST com origem exata e CSRF. `Origin: null` continua bloqueado. Os testes de integração verificam as políticas da página e dos redirecionamentos e negam consentimento com origem opaca ou externa, inclusive com cookie e CSRF válidos.

A política `form-action` da mesma página inclui os dois caminhos de callback ChatGPT aceitos pelo conector, permitindo o redirecionamento final após o formulário em navegadores que aplicam CSP também a esse salto. Não são liberadas outras origens. As outras páginas mantêm `form-action 'self'`.

Após implantar, conferir `version=0.1.1` em `/health` e iniciar novamente a conexão OAuth pelo ChatGPT. Não reutilizar uma URL de callback de uma tentativa anterior. A consulta real de conta continua necessária para validar as credenciais Google Ads.

## Fontes oficiais

- [Workers com monorepositórios](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)
- [Secrets no painel Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Provisionamento automático de recursos](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [Autenticação MCP no ChatGPT](https://developers.openai.com/plugins/build/auth)
