# Google Ads Stoicus Secure — preparação de leitura

Estado: adaptador de leitura e servidor MCP preparados para um Worker Google separado. A implantação e a configuração de credenciais reais permanecem pendentes. Uma consulta manual no OAuth Playground retornou HTTP 200 e confirmou identidade, moeda e fuso da conta; isso não valida a implantação deste servidor nem acesso de escrita.

Esta pasta é independente do código Meta. O Worker configurado na raiz continua sendo o Meta; publicar este módulo exige um host separado.

## Escopo autorizado

- Conector próprio para uma única conta Google Ads, com primeira etapa de leitura.
- API habilitada no projeto Google Cloud, com acesso de Exploração informado na configuração.
- A criação de chave de conta de serviço foi bloqueada por política organizacional. O caminho escolhido agora é OAuth de usuário, sem alterar essa política.
- A conta de serviço existente recebeu acesso Padrão por escolha da responsável. O OAuth de usuário usa as permissões da pessoa que autorizou. Este adaptador só consulta.
- Não reutilizar orçamento, datas, públicos ou IDs Meta. Campanhas Google e ativação exigem briefing e autorização próprios.

## Implementado

`read-only.mjs` fornece descritores de três ferramentas e um despachante interno:

| Ferramenta | Escopo |
| --- | --- |
| `google_ads_get_account` | Identidade, moeda e fuso da única conta configurada |
| `google_ads_list_campaigns` | Até 1.000 campanhas não removidas e seus orçamentos |
| `google_ads_get_performance` | Métricas por campanha em período explícito de até 93 dias |

Os destinos HTTP são fixos: OAuth do Google e `GoogleAdsService.Search`. O POST de Search é consulta. Não há mutações, consulta livre, URL livre ou troca de conta pelo chamador. Resultados preservam moeda, fuso e micros monetários. Inventário parcial retorna `complete=false`.

Cada chamada valida novamente o operador no host e confere a identidade da conta na resposta Google. O escopo OAuth `adwords` permite acesso amplo; a restrição deste adaptador vem dos métodos de consulta e da conta fixa, não de um escopo OAuth exclusivo de leitura.

Erros expõem apenas códigos controlados, HTTP e identificadores seguros. Respostas OAuth, textos brutos, tokens e chaves não são retornados. `invalid_grant` retorna `reauthorization_required=true`: a autorização precisa ser refeita, sem troca automática para outra identidade. Não há retentativas automáticas. Cada requisição tem timeout de 15 segundos e limite de resposta de 2 MB.

## Configuração no servidor

Os valores são variáveis ou secrets do host Google, nunca argumentos de ferramentas, conteúdo do chat, arquivos versionados ou logs.

| Nome | Uso |
| --- | --- |
| `PUBLIC_ORIGIN` | Origem HTTPS exata do Worker Google, sem barra final nem caminho |
| `STOICUS_ALLOWED_EMAILS` | E-mails Google autorizados, separados por vírgula; lista vazia bloqueia acesso |
| `GOOGLE_ADS_CUSTOMER_ID` | ID confirmado de dez dígitos; aceita também a máscara `123-456-7890` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Opcional, somente com conta gerente confirmada |
| `GOOGLE_ADS_API_VERSION` | Versão fixada em `v25` |
| `GOOGLE_ADS_AUTH_MODE` | `user_oauth` para o fluxo atual; `service_account` para o fluxo anterior |
| `GOOGLE_ADS_CLIENT_ID` | Identificador do cliente OAuth próprio, modo `user_oauth` |
| `GOOGLE_ADS_CLIENT_SECRET` | Secret do cliente OAuth, modo `user_oauth` |
| `GOOGLE_ADS_REFRESH_TOKEN` | Secret obtido com acesso offline e escopo `adwords`, modo `user_oauth` |
| `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` | Secret exigido somente no modo `service_account` |

O Worker desta pasta exige `user_oauth`. No adaptador isolado, omitir o modo mantém `service_account` por compatibilidade com o código anterior. Não há fallback. Configuração incompleta é rejeitada antes da rede. No modo OAuth, o servidor envia a concessão `refresh_token` para `https://oauth2.googleapis.com/token`; nenhuma chave de conta de serviço é necessária. O modo antigo assina JWT RS256 sem impersonação e permanece disponível apenas onde autorizado.

O token de acesso fica em memória. Chamadas concorrentes compartilham uma renovação por instância; renovação próxima ao vencimento ocorre antes da consulta. HTTP 401 invalida o cache, sem repetir automaticamente a operação. Atualizar secrets exige reconstruir a instância, pois a configuração é copiada na criação. Limites compartilhados entre várias instâncias dependem do host.

## Transporte e login

`worker.mjs` publica Streamable HTTP em `/mcp`, com SDK MCP e `@cloudflare/workers-oauth-provider` fixados no lockfile. Usa sessões MCP sem estado; o adaptador é criado por requisição, aproveitando cache de token apenas nas consultas daquela requisição. O token MCP é diferente do token Google e tem audiência restrita à origem e ao caminho configurados.

O login Google solicita somente `openid email` para identificar o operador; as leituras Ads usam o refresh token guardado no servidor. O fluxo exige PKCE S256, correspondência entre state e cookie HttpOnly/Secure, e confirmação de e-mail verificado presente na lista de operadores. O consentimento mostra o cliente e o destino antes de emitir a autorização MCP. A lista de operadores e o escopo efetivo são conferidos novamente em cada requisição protegida e renovação MCP.

O servidor aceita callbacks ChatGPT reconhecidos, oferece CIMD com proteção SSRF da Cloudflare e DCR como alternativa. Tokens reduzidos a escopos insuficientes não herdam a permissão antiga. Erros, redirects e respostas são protegidos contra cache e envio de Referer; nenhum token Google é entregue ao cliente MCP. A KV própria armazena concessões MCP e sessões temporárias de login de dez minutos.

Sem as variáveis obrigatórias, o servidor responde `503` e não expõe ferramentas. `/health` mostra versão e presença de configuração; nunca testa Google nem comprova validade das credenciais. O bundle não inclui código ou bindings do Meta.

## Autorização temporária e uso contínuo

O teste usa cliente próprio no OAuth Playground, com URI de redirecionamento exatamente `https://developers.google.com/oauthplayground`. Credenciais próprias evitam a revogação de 24 horas específica das credenciais padrão do Playground.

Um app externo com status OAuth **Testando** e escopo `adwords` recebe refresh tokens com validade de sete dias. Para operação contínua, concluir a configuração de publicação aplicável, com apresentação e política de privacidade que descrevam o conector. Páginas institucionais sobre cursos não demonstram sozinhas como o aplicativo usa dados Google. Publicação OAuth não equivale a implantação MCP, nem torna tokens irrevogáveis.

Se uma credencial aparecer em captura, chat ou log, revogar o acesso do aplicativo na Conta do Google e refazer a autorização. O novo refresh token deve ser salvo pelo painel seguro de secrets, com o client ID e secret correspondentes.

Desde 09/09/2026, a documentação informa que níveis de acesso são controlados pelo projeto Google Cloud e que developer tokens foram descontinuados. Este adaptador não envia esse cabeçalho. Confirmar o nível no projeto do cliente OAuth usado.

## Pendências para conectar

1. Criar o Worker Google a partir desta pasta conforme [DEPLOY.md](./DEPLOY.md).
2. Salvar as credenciais pelo painel de secrets e configurar origem, conta e operadores.
3. Adicionar a origem do Worker com caminho `/callback` ao cliente OAuth Google já criado; preservar o redirect do Playground.
4. Conectar `/mcp` no ChatGPT, autorizar pelo Google e conferir a conta retornada na primeira consulta real do servidor.
5. Resolver a publicação OAuth para uso contínuo. Conversões, GA4, segmentação e entrega exigem validações adicionais. Não ativar anúncios durante esta validação.

## Validação local

```sh
cd google-ads
npm ci
npm test
```

Validação desta revisão: 28 testes passaram e o bundle foi gerado pelo Wrangler. Os testes usam chave efêmera, credenciais fictícias e Google simulado. Além do adaptador, executam o Worker empacotado no Miniflare com a biblioteca OAuth e o SDK reais: descoberta, registro, state/cookie, login, consentimento, troca de código, audiência, escopos, catálogo e chamada MCP. Não comprovam implantação nem substituem o teste real com a conta da Stoicus.

## Fontes

- [OAuth para uma única conta](https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication)
- [Renovação de tokens no servidor](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [Validade de refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration)
- [OAuth Playground](https://developers.google.com/oauthplayground/)
- [Gerenciar acesso de aplicativos](https://support.google.com/accounts/answer/13533235?hl=pt-BR)
- [Mudança para projetos Google Cloud](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [Conta de serviço no Google Ads](https://developers.google.com/google-ads/api/docs/oauth/service-accounts)

Fontes internas: Guia Mestre Meta v2, Automação Meta v1 e Guia de Continuidade v3. Reutilizar controles e aprendizados; parâmetros históricos permanecem específicos das campanhas Meta.
