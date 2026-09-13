# Google Ads Stoicus Secure — preparação de leitura

Estado: adaptador interno testável, ainda sem transporte MCP implantado e sem acesso real à conta Google Ads. Esta pasta é independente do código e da implantação do Meta. Não executar o deploy do Worker Meta para publicar este módulo.

## Decisões desta conversa

- A responsável escolheu conector próprio (opção 2) e confirmou que já existe conta Google Ads.
- ID da conta Google Ads e acesso administrativo ainda não foram confirmados. Não reutilizar IDs Meta.
- A preparação técnica está autorizada; nenhuma campanha Google, orçamento, data, público ou ativação foi aprovada.
- Primeiro validar leitura da conta; depois implementar criação pausada com pré-validação, idempotência durável, serialização por conta, auditoria e conferência pós-gravação.
- Sul significa SC, PR e RS. Não transportar IDs de localização, faixas etárias, cargos ou modelos de orçamento do Meta para o Google. Resolver suporte e IDs do Google quando houver briefing.

## Implementado

`read-only.mjs` fornece descritores de três ferramentas e um despachante interno:

| Ferramenta | Escopo |
| --- | --- |
| `google_ads_get_account` | Identidade, moeda e fuso da única conta configurada |
| `google_ads_list_campaigns` | Inventário limitado a 1.000 campanhas não removidas e orçamentos |
| `google_ads_get_performance` | Métricas por campanha em período explícito de até 93 dias |

Há apenas dois destinos HTTP: OAuth do Google e `GoogleAdsService.Search`, ambos fixos. O POST de Search é consulta. Não existe método de mutação, consulta livre, URL livre ou override do ID pelo chamador. Resultados preservam moeda, fuso e micros monetários. Inventário parcial retorna `complete=false`; não serve como auditoria completa. Consultas são sequenciais dentro de cada operação; renovação de token concorrente é consolidada dentro de uma instância. Coordenação de múltiplas instâncias/limites de conta ainda depende do host.

Erros retornam código controlado, HTTP e códigos estruturados do Google quando disponíveis. Textos brutos, respostas OAuth, assertions, tokens e chave privada não são expostos. Não há retentativa automática. Há timeout de 15 segundos por requisição e limite de 2 MB por resposta.

## Autenticação prevista

Para a única empresa, conta de serviço dedicada com acesso **somente leitura** na conta Google Ads durante esta etapa. Google Ads usa o mesmo escopo OAuth para leitura e escrita; o papel atribuído na conta e a ausência de mutações no adaptador fazem a restrição efetiva. Leitura bem-sucedida nunca comprova autorização de escrita.

Configuração interna, nunca argumentos das ferramentas:

| Nome | Armazenamento |
| --- | --- |
| `GOOGLE_ADS_CUSTOMER_ID` | Variável: ID de dez dígitos, fornecido/confirmado pela responsável |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Opcional; somente se houver conta gerente confirmada |
| `GOOGLE_ADS_API_VERSION` | Versão fixada em `v25` |
| `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` | Secret do Worker Google; nunca chat, arquivo versionado ou logs |

A chave da conta de serviço é assinada no servidor usando Web Crypto RS256, sem impersonação. O JWT é trocado no endpoint OAuth oficial, com cache apenas em memória. Criar a chave/configurar o secret será feito pelo fluxo seguro da plataforma; nenhum valor real está incluído nesta pasta.

Desde 09/09/2026 o Google informa que os níveis de acesso passaram ao projeto Google Cloud e que o cabeçalho de developer token é opcional/ignorado. Habilitar a Google Ads API e obter nível permitido para conta de produção no projeto correto. Não criar MCC ou developer token por pressuposto. Revalidar esta orientação no momento da conexão, pois algumas páginas de exemplos ainda contêm instruções anteriores.

## Pendências para conectar

1. Confirmar ID cliente Google Ads e quem possui acesso administrativo.
2. Identificar/criar o projeto Google Cloud da Stoicus, habilitar a API e confirmar acesso a produção.
3. Criar identidade de serviço dedicada e conceder leitura somente à conta confirmada. Guardar credencial pelo canal de secrets.
4. Implementar e testar transporte MCP autenticado em Worker separado, com política restrita aos operadores Stoicus. `authorize()` é contrato obrigatório do adaptador; ele deve verificar a sessão atual no servidor e nunca confiar em identidade fornecida pelo chamador. Este módulo NÃO implementa essa verificação nem é um servidor HTTP.
5. Registrar os descritores e despachar chamadas pelo SDK MCP no host, convertendo erros do adaptador em `isError=true`. Não compartilhar transporte, KV OAuth, chaves ou bindings do Meta por conveniência.
6. Realizar teste de autenticação ponta a ponta, acesso negado e isolamento; publicar somente a versão revisada e conectar no ChatGPT. Nenhuma URL Google MCP existe nesta etapa.
7. Ler a conta real e conferir nome, ID, moeda, fuso, acesso e inventário. Medição de conversões/GA4, segmentação, anúncios e cobrança exigirão consultas adicionais; não inferir essas validações das três ferramentas iniciais.

Próxima informação necessária da responsável: ID do cliente Google Ads, no formato `123-456-7890` (exemplo fictício). O ID identifica a conta e não concede acesso por si só.

## Validação local

```sh
node --test google-ads/tests/*.test.mjs
```

Os testes usam chave efêmera gerada em memória e rede simulada. Confirmam assinatura JWT, controle de conta, acesso negado, ausência de escrita, preservação de micros, datas, ocultação de segredos, cache, limites e ausência de retries. Não comprovam autorização Google, compatibilidade real das consultas nem conexão MCP.

## Fontes

- [Mudança de developer tokens para projetos Google Cloud](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [Conta de serviço no Google Ads](https://developers.google.com/google-ads/api/docs/oauth/service-accounts)
- [Modelo de acesso](https://developers.google.com/google-ads/api/docs/oauth/access-model)
- [OAuth de serviço e assinatura JWT](https://developers.google.com/identity/protocols/oauth2/service-account)
- [Versões da API](https://developers.google.com/google-ads/api/docs/release-notes)

Fontes internas consultadas: Guia Mestre Meta v2, Automação Meta v1 e Guia de Continuidade v3. Reutilizar controles e aprendizados; parâmetros históricos permanecem específicos das campanhas Meta.
