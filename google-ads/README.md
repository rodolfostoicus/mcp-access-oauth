# Google Ads Stoicus Secure — gestão da conta

Versão **0.2.1**. A responsável autorizou expressamente ampliar o conector existente para ler, criar, modificar e remover recursos. A conexão de leitura da versão anterior foi confirmada pela responsável em uma consulta MCP à conta Stoicus. A atualização implementa as operações de gestão; o consentimento OAuth de escrita precisa ser concedido à conexão que vai utilizá-las.

O Worker `stoicus-google-ads-mcp`, a URL `/mcp` e o plugin existentes são mantidos. Esta pasta é independente do Worker Meta na raiz do repositório. As credenciais continuam nos secrets do Cloudflare.

## Ferramentas

| Ferramenta | Função |
| --- | --- |
| `google_ads_get_account` | Conta, moeda, fuso e identidade conferida no Google |
| `google_ads_list_campaigns` | Até 1.000 campanhas e orçamentos; indica inventário parcial |
| `google_ads_get_performance` | Métricas por período explícito de até 93 dias |
| `google_ads_query` | GAQL SELECT para todos os recursos consultáveis, incluindo paginação |
| `google_ads_search_fields` | Metadados de campos para construir consultas válidas |
| `google_ads_get_capabilities` | Catálogo de recursos, operações nativas e escopos da conexão |
| `google_ads_create` | Criação de um recurso |
| `google_ads_update` | Alteração de campos de um recurso por máscara explícita |
| `google_ads_remove` | Remoção nativa de um recurso por nome completo |
| `google_ads_mutate` | Lote transacional de criação, alteração e remoção |
| `google_ads_get_operation` | Recibo persistente de uma operação pelo UUID |

## Cobertura real

O arquivo `resource-catalog.json` registra **78 tipos de recurso** e as operações CRUD efetivamente expostas pelos serviços da Google Ads API v25. Nomes, caminhos REST, padrões de nomes de recurso, máscaras e capacidades foram conferidos nos protos oficiais do repositório `googleapis/googleapis`, consultados em 13/09/2026. Cada entrada inclui o arquivo de origem.

São 62 tipos compatíveis com `GoogleAdsService.Mutate` e 16 atendidos por seus serviços específicos. A cobertura inclui campanhas, grupos, anúncios, orçamentos, lances, critérios/segmentação, palavras-chave, ativos e associações, Performance Max, públicos, listas, conversões, etiquetas, experimentos, planejamento e configurações de conta. Serviços de acesso de usuários e faturamento também estão no catálogo, sujeitos às permissões e condições nativas do Google.

Não significa que todo tipo aceita toda ação: `ad` aceita atualização, enquanto a criação/remoção de um anúncio usa `ad_group_ad`; `asset` e `audience` não têm remoção nativa nesses serviços. Remoção pode ser irreversível e não apaga o histórico. Ações especializadas fora do CRUD — upload de conversões, aplicar recomendações, promover experimentos, reservar campanhas ou executar batch jobs — não são implementadas pelas ferramentas de mutação desta versão. O nível de acesso da API e o papel do usuário no Google continuam determinando quais operações são permitidas.

## Operar

1. Consultar os objetos e `google_ads_get_capabilities` para identificar o recurso correto e suas operações. Consultar `google_ads_search_fields` quando necessário.
2. Preparar dados REST em **camelCase**. Valores monetários em micros são inteiros exatos, preferencialmente strings. A conta de destino vem exclusivamente da configuração do servidor.
3. Usar `validate_only=true` para prévia, ou `validate_only=false` para executar uma operação já autorizada. A execução faz sua própria validação Google antes da gravação quando o serviço a oferece. Não é necessário repetir um pedido de autorização já concedido para o mesmo trabalho.
4. A gravação exige um `request_id` UUID estável. Reenviar o mesmo UUID e conteúdo retorna o recibo; mudar o conteúdo com o mesmo UUID é rejeitado. Um POST incerto não é reenviado automaticamente, mesmo com outro UUID e conteúdo idêntico.
5. Conferir `mutation_accepted`, `readback_verified`, `readback_complete` e os detalhes de cada recurso. Consultar os campos restantes por GAQL quando a releitura não for completa.

Criações de campanhas, grupos, anúncios e grupos de ativos assumem `PAUSED` quando o status é omitido; `ENABLED` explícito permite ativação. Alterações de orçamento e status não têm tetos de negócio fixos no conector. Usar os valores e o trabalho autorizados pela responsável, sem importar orçamentos ou parâmetros de campanhas Meta.

`google_ads_mutate` aceita até 100 operações e 6 MB de conteúdo por chamada. Lotes combinados usam `partialFailure=false`, incluindo referências temporárias negativas. Tipos não suportados pelo endpoint unificado exigem lote de um único tipo; serviços com operação singular aceitam uma operação. Não há execução oculta de vários lotes nem mudanças parciais deliberadas.

Quatro serviços não oferecem `validateOnly`: `batch_job`, `billing_setup`, `customer_user_access` e `customer_user_access_invitation`. Sua prévia é **somente local**, claramente identificada; nenhuma chamada de mutação é usada para simular. A execução real chama o método nativo uma vez.

## Diagnóstico de políticas — 0.2.1

Erros `POLICY_FINDING` também retornam `policy_findings` com até 20 identificadores de política e tipos reconhecidos. O diagnóstico omite mensagens brutas, evidências, URLs e credenciais. Não solicita exceções, não altera a validação Google e não repete gravações; serve para orientar a correção do anúncio ou destino.

## Evidência e recuperação

Um Durable Object SQLite próprio por conta serializa as gravações e registra UUID, hash canônico, estágio e recibo. Tokens, secrets e o conteúdo completo dos anúncios não são armazenados nesse registro. `GOOGLE_ADS_OPERATIONS` é um binding interno, sem rota pública direta.

A resposta `mutation_accepted=true` significa que o Google devolveu uma confirmação consistente para as operações e os recursos esperados. O reconhecimento é persistido antes da releitura. Falha na consulta posterior não repete a gravação. A releitura automática é limitada aos dez primeiros recursos; campos aninhados de criação que não foram conferidos aparecem em `unverified_fields`, sem afirmar verificação completa. Campos limpos/default omitidos pelo protobuf também não são declarados verificados sem evidência.

`COMPLETE` indica fim do processamento, não garante sozinho `readback_verified=true`. `COMMITTED` preserva o reconhecimento Google mesmo se a releitura não terminar. `UNKNOWN` ou `DISPATCHED` sem conclusão não autorizam repetição automática: consultar o recibo e os recursos atuais. A mesma proposta incerta permanece bloqueada. Recibos são históricos e não representam o estado atual dos anúncios.

O bloqueio de uma execução em andamento tem janela de três minutos, superior aos timeouts limitados das etapas. Após interrupção antes de qualquer envio, uma operação `VALIDATING` pode continuar com o mesmo UUID. Após envio, o recibo persistente impede sua repetição. Operações diferentes podem voltar a ser processadas após a janela; o conector não cancela operações Google que já foram enviadas. Alterações feitas fora do conector não ficam sob seu controle de concorrência.

As consultas personalizadas retornam a página Google sem cortar linhas e informam `next_page_token`. Reutilizar a consulta original para a próxima página. Cada chamada HTTP tem timeout de 15 segundos e resposta limitada a 2 MB; uma resposta maior falha explicitamente, devendo-se selecionar menos campos/linhas. Os três atalhos antigos conservam seus limites originais.

## OAuth e configuração

O escopo Google `https://www.googleapis.com/auth/adwords` já dá acesso conforme o papel da pessoa no Google Ads. A restrição anterior era do servidor MCP. A versão nova separa `google_ads.read` e `google_ads.write` nos tokens próprios do conector. Tokens antigos de leitura **não recebem escrita automaticamente**. As ferramentas de escrita retornam desafio OAuth de escopo insuficiente; a tela de consentimento mostra **Autorizar gestão completa** quando escrita é solicitada.

O login Google continua com `openid email`, PKCE S256, state/cookie, e-mail verificado e lista de operadores autorizados. Google Ads usa o refresh token guardado no servidor. O ChatGPT recebe apenas o token próprio do conector. A correção da versão 0.1.1 para origem do formulário de consentimento permanece preservada.

| Configuração | Uso |
| --- | --- |
| `PUBLIC_ORIGIN` | Origem HTTPS exata do Worker, sem barra final ou `/mcp` |
| `STOICUS_ALLOWED_EMAILS` | Operadores permitidos; lista vazia bloqueia acesso |
| `GOOGLE_ADS_CUSTOMER_ID` | Única conta de destino |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Opcional, conta gerente confirmada |
| `GOOGLE_ADS_AUTH_MODE` | `user_oauth` |
| `GOOGLE_ADS_API_VERSION` | `v25` |
| `GOOGLE_ADS_CLIENT_ID` | Cliente OAuth próprio |
| `GOOGLE_ADS_CLIENT_SECRET` | Secret do cliente OAuth |
| `GOOGLE_ADS_REFRESH_TOKEN` | Secret da autorização Google com escopo `adwords` |
| `OAUTH_KV` | Concessões MCP e sessões temporárias de login |
| `GOOGLE_ADS_OPERATIONS` | Durable Object SQLite para gravações e recibos |

Não é preciso alterar a política que bloqueia chaves de conta de serviço nem substituir secrets válidos. O transporte isolado antigo de conta de serviço permanece compatível, mas o Worker exige `user_oauth`. Não há fallback automático de identidade nem encaminhamento de credenciais para destinos arbitrários. Erros expõem códigos, posições de campos, HTTP e request ID controlados; nunca textos brutos Google ou tokens.

`/health` mostra `version=0.2.1`, `mode=management`, presença de configuração e `write_infrastructure_ready`. Não testa Google: `google_connection_tested=false` permanece literal. A leitura da conta não comprova permissão nativa de escrita.

Para operação contínua, concluir a publicação OAuth aplicável: um app externo em Testando com escopo `adwords` recebe refresh token limitado a sete dias. A publicação OAuth é independente da implantação Worker e da autorização MCP. Desde 09/09/2026, os níveis de acesso Google Ads são controlados pelo projeto Google Cloud; este adaptador não envia developer token.

## Validação e implantação

Executar `npm ci` e `npm test` nesta pasta. Os testes usam Google e credenciais fictícios, com o Worker empacotado, SDK MCP, biblioteca OAuth e Durable Object SQLite reais no Miniflare. Cobrem leitura anterior, escopos, consentimento, consulta paginada, catálogo, CRUD, ativação, atomicidade, campos exatos, duplicação, concorrência e falhas incertas. Não fazem alterações em uma conta Google real.

Seguir [DEPLOY.md](./DEPLOY.md). A revisão permanece no PR 41; implantação automática do Worker Google pela branch `ads-google`, raiz `google-ads`, comando `npm run deploy` com `--keep-vars`. Nenhuma alteração em anúncios é necessária para instalar esta versão.

## Fontes

- [Mutação de recursos](https://developers.google.com/google-ads/api/docs/mutating/overview)
- [Exemplos REST, máscaras, lotes e remoção](https://developers.google.com/google-ads/api/rest/examples)
- [MutateOperation v25](https://developers.google.com/google-ads/api/reference/rpc/v25/MutateOperation)
- [Protocolos oficiais v25](https://github.com/googleapis/googleapis/tree/master/google/ads/googleads/v25)
- [OAuth para uma conta](https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication)
- [Validade dos refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Durable Objects e armazenamento SQLite](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Autenticação MCP](https://developers.openai.com/plugins/build/auth)
