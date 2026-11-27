# API de parceiros — etapas 1 a 4

API server-to-server em Node.js/PostgreSQL, independente das sessões sociais.
Status, tribos e eventos provisionais estão disponíveis em `/api/v1/partners`.
O contrato está em `partner-openapi.json` (OpenAPI 3.1).

## Persistência e migrations

`1000_partner_foundation.sql` cria `partners`, `partner_applications`,
`partner_api_keys`, `partner_rate_limits` e `partner_audit_logs`. Não altera nem
preenche tabelas sociais. As FKs impedem credenciais associadas à empresa errada
e exclusão acidental de empresas/aplicações com histórico.

`1001_partner_audit_integrity.sql` reforça, de forma aditiva, o vínculo entre
empresa, aplicação e credencial nos registros de auditoria. A migration inicial
foi preservada após sua aplicação automática pelo backend local em modo watch.

`1002_partner_resources.sql` cria `partner_tribes` e `partner_events`, sem alterar
as tabelas sociais. Recursos provisionais não aparecem no feed, não criam usuários
e não recebem autoria humana fictícia. A aplicação criadora é proprietária
operacional; a unicidade PostgreSQL em `(partner_id, external_event_id)` arbitra
requisições concorrentes e a aplicação é verificada em toda consulta/mutação.
`1003_partner_social_tribe_unlink.sql` permite excluir normalmente uma tribo social
vinculada, mantendo o recurso do parceiro como provisional/desvinculado.
`1004_partner_event_coordinates.sql` exige latitude/longitude válidas em conjunto
ou ambas ausentes.
`1005_partner_social_link_consent.sql` cria prévias de autorização de uso único e
expiração curta, além do histórico de autorização/revogação com os IDs dos
moderadores. Ela aborta se encontrar ponteiros ou auditorias de vínculos legados
sem evidência verificável de consentimento. A exclusão de uma tribo registra a
revogação técnica no histórico, preservando o UUID social e o autorizador.
`1006_partner_social_link_delete_audit.sql` adiciona a entrada de auditoria da
revogação automática quando a tribo social é excluída.
`1007_partner_organizer_grants.sql` cria o histórico independente de grants
humanos, adiciona o escopo `organizer-grants:read` e registra revogações por
membership encerrada ou exclusão da tribo social. Grants preservam os ciclos
anteriores e não são apagados quando o vínculo social é revogado.
`1008_partner_event_participants.sql` adiciona cancelamento terminal de eventos,
registros de participantes/ingressos provisionais, segredos de resgate com hash,
prévia e confirmação autenticada, associação revogável à conta e histórico de
consentimento. As FKs compostas impedem cruzar parceiro/aplicação/evento.
Eventos com qualquer registro de participante não podem ser reatribuídos a outra
tribo provisional.
`1009_partner_participant_secret_retention.sql` vincula desafios à versão e ao hash
do segredo, cria tombstones globais para hashes usados e prepara auditoria agregada
e métricas de execução do job. Desafios pendentes anteriores à migration são
invalidados; desafios já consumidos permanecem apenas para idempotência.
`1010_partner_event_retention_anchor.sql` adiciona um marco terminal de retenção por
evento, faz backfill para eventos existentes com participantes e instala uma
proteção no banco contra alteração de datas após esse marco.
O backfill usa as datas atualmente persistidas; datas finais manipuladas por
versões anteriores não podem ser reconstruídas sem um histórico anterior confiável.
`1011_partner_preview_secret_nullability.sql` corrige incrementalmente a constraint
de hash de prévias em bancos que já aplicaram uma versão mais restritiva da 1009.
Pode ser reaplicada: remove e recria somente as constraints de
`claim_token_hash`, preservando valores e hashes existentes, e revoga privilégios de
leitura da role `PUBLIC` na tabela de tombstones.

## Retenção e privacidade da auditoria de participantes

Noventa dias depois do marco terminal do evento, os registros individuais do
participante e suas linhas de histórico/auditoria operacional são removidos. Os
eventos com participantes recebem `participant_retention_at` quando o fim previsto
é atingido; para eventos cancelados, o marco é o instante de cancelamento, ou o fim
previsto se ele já tiver passado. Evento sem `endsAt` usa `startsAt`. Datas de um
evento com participantes podem ser corrigidas/remarcadas antes do término, mas são
imutáveis depois dele. A regra é aplicada na transação da API e protegida também por
trigger no banco. Eventos sem participantes mantêm a regra anterior de edição de
datas; só uma futura inscrição poderá associá-los a dados de participante.

As linhas individuais de histórico/auditoria são consolidadas em contagens por
parceiro, aplicação, evento, ação e origem (`participant_history` ou `partner_audit`),
sem UUID de participante/usuário, identificador externo ou timestamp da operação.
Auditoria legada sem associação recuperável a um evento é consolidada por
parceiro/aplicação/ação e fica sem `partner_event_id`. Metadados do evento permanecem;
as contagens não mantêm qual participante executou cada ação. Essa classificação
como **anonimização** aplica-se às linhas agregadas, não ao conjunto inteiro de dados
retidos.

Os tombstones de segredo são **pseudonimizados**, não anonimizados. Mantêm
indefinidamente `SHA-256`, versão e data de registro; a FK remove o ponteiro ao
participante após a retenção. A permanência é necessária para rejeitar a reutilização
de qualquer segredo histórico; um segredo ainda conhecido pode ser hasheado e
correlacionado ao tombstone. Não há endpoint da API para consultar/listar tombstones:
o backend só tenta inseri-los e recebe um conflito genérico, sem revelar parceiro,
aplicação ou dono do hash. Os hashes não permitem recuperar segredos.

### Papel SQL e tombstones

Na tabela `partner_event_participant_claim_token_hashes`, o runtime não recebe
privilégios diretos. Para registrar o hash atual e cada rotação, chama somente
`record_partner_participant_claim_token_hash(...)`, função `SECURITY DEFINER` do
migrator que insere com `ON CONFLICT (token_hash) DO NOTHING` e retorna apenas
sucesso/conflito. O runtime precisa de `EXECUTE` nessa função; não precisa de
`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` ou `TRIGGER` na tabela.
A FK `ON DELETE SET NULL` remove o ponteiro ao participante quando o job o retém.
Migrations usam identidade separada com privilégios DDL/owner.

O papel runtime deve ser não-superuser, `NOBYPASSRLS`, não ser proprietário da tabela
e não poder assumir outros papéis. `EXECUTE` na função não permite enumerar hashes;
não conceder acesso de leitura por API ou criar rota para enumeração.

Exemplo de provisionamento da role runtime; ela deve ser criada pelo DBA e suas
credenciais entregues pelo gerenciador de segredos:

```sql
CREATE ROLE tribes_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT EXECUTE ON FUNCTION record_partner_participant_claim_token_hash(CHAR, UUID, BIGINT)
  TO tribes_app;
```

Essa role ainda precisa dos privilégios DML que o backend usa nas demais tabelas;
esses privilégios também não podem tornar `tribes_app` owner, superuser, `BYPASSRLS`
ou membro de um papel com leitura da tabela de tombstones. Em produção, configure
`DATABASE_RUNTIME_ROLE=tribes_app` e use essa mesma role em `DATABASE_URL`. A cada
startup, a conexão de migration revoga os privilégios diretos dessa role sobre a
tabela e `PUBLIC` sobre a função, e concede somente `EXECUTE` à role runtime; em seguida, a conexão runtime
verifica superuser, `BYPASSRLS`, ownership, membership/SET ROLE e privilégios efetivos, falhando
fechado se algum acesso direto à tabela ou execução pública persistir. `MIGRATION_DATABASE_URL` precisa
ter privilégios de owner/GRANT para executar esse ajuste. O ajuste ACL não restringe
owner ou superuser — a validação runtime rejeita esses casos.

O Compose de desenvolvimento usa `tribes`, superuser de bootstrap, para runtime e
migrations. O Compose de testes usa `tribes_migrator` superuser apenas para migrations
e fixtures; o backend usa `tribes_app` não-owner e a integração valida seus privilégios
efetivos. Ambos são locais/efêmeros, não prova das roles de produção. O Compose de
produção configura `tribes_migrator` como owner/bootstrap e
monta `backend/postgres-init-runtime-role.sh`, que cria `tribes_app` não-superuser e
concede os privilégios operacionais nas outras tabelas/sequências. Para tombstones,
o startup substitui esses grants por `EXECUTE` na função somente e valida a role runtime. Esse
bootstrap roda apenas em volume PostgreSQL vazio. Em volume existente, o entrypoint
do PostgreSQL não o repete: provisionar/ajustar roles e grants por DBA antes de
iniciar, conforme `SECURITY.md`. Credenciais e configuração de bancos externos à
Compose continuam sendo evidência operacional não disponível neste repositório.

Executar as consultas abaixo pela conexão runtime efetivamente configurada no
backend, sem divulgar a senha/URL:

```sql
SELECT current_user, session_user, runtime_role.rolsuper, runtime_role.rolbypassrls,
       runtime_role.rolinherit,
       pg_get_userbyid(table_info.relowner) AS table_owner,
       has_table_privilege(current_user, table_info.oid, 'SELECT') AS can_select,
       has_table_privilege(current_user, table_info.oid, 'INSERT') AS can_insert,
       has_table_privilege(current_user, table_info.oid, 'UPDATE') AS can_update,
       has_table_privilege(current_user, table_info.oid, 'DELETE') AS can_delete,
       has_table_privilege(current_user, table_info.oid, 'TRUNCATE') AS can_truncate,
       has_table_privilege(current_user, table_info.oid, 'REFERENCES') AS can_reference,
       has_table_privilege(current_user, table_info.oid, 'TRIGGER') AS can_trigger,
       has_function_privilege(current_user, runtime_function.oid, 'EXECUTE') AS can_execute
FROM pg_class table_info
JOIN pg_roles runtime_role ON runtime_role.rolname = current_user
JOIN pg_proc runtime_function
  ON runtime_function.pronamespace = table_info.relnamespace
 AND runtime_function.proname = 'record_partner_participant_claim_token_hash'
 AND runtime_function.pronargs = 3
WHERE table_info.oid = 'partner_event_participant_claim_token_hashes'::regclass;

SELECT member_role.rolname, member_role.rolsuper
FROM pg_roles member_role
WHERE pg_has_role(current_user, member_role.oid, 'MEMBER');

SELECT acl.privilege_type
FROM pg_class table_info
CROSS JOIN LATERAL aclexplode(COALESCE(
  table_info.relacl, acldefault('r', table_info.relowner)
)) acl
WHERE table_info.oid = 'partner_event_participant_claim_token_hashes'::regclass
  AND acl.grantee = 0;

SELECT acl.privilege_type
FROM pg_proc runtime_function
CROSS JOIN LATERAL aclexplode(COALESCE(
  runtime_function.proacl, acldefault('f', runtime_function.proowner)
)) acl
WHERE runtime_function.proname = 'record_partner_participant_claim_token_hash'
  AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE';
```

Antes do deploy, guardar evidência redigida mostrando `rolsuper = false`,
`rolbypassrls = false`; runtime distinto do owner; nenhuma membership em outra role;
`can_execute = true`; todas as permissões diretas sobre a tabela como `false`; nenhum
EXECUTE público na função; e migrations executadas por `MIGRATION_DATABASE_URL`, distinta da conexão
runtime. O código usa `MIGRATION_DATABASE_URL` para `schema_migrations`, DDL e ajuste
da ACL; queries normais usam `DATABASE_URL`. O repositório não contém valores ou
evidência das roles reais de produção. Se a inicialização falhar na validação, não
desabilitar o bloqueio: corrigir roles/ACL no ambiente e repetir a verificação.

A migration consegue semear o hash ainda presente em cada participante; hashes
apagados por versões anteriores — inclusive segredos já limpos em registros
consumidos — não podem ser reconstruídos. A garantia de não reutilização vale para
hashes que permanecem ou são registrados a partir da aplicação da `1009`; a lacuna
anterior é histórica e não retroativa. Da mesma forma, a `1010` não consegue
recuperar um fim de evento real que uma versão anterior já tenha sobrescrito; o
marco para esses eventos começa a partir da data atualmente persistida.

Cada execução bem-sucedida grava timestamp, duração e quantidades processadas em
`partner_participant_retention_runs`, além de um log operacional sanitizado.
Execuções concorrentes serializam por advisory lock; transformação e resultado são
transacionais e repetições não voltam a agregar linhas removidas.

O backend aplica migrations no startup por `MIGRATION_DATABASE_URL` (com fallback a
`DATABASE_URL` nos ambientes locais), conforme o mecanismo existente de
`schema_migrations`, transações e advisory lock. O executor registra nomes, não
checksums: alterações em migration já registrada não são reaplicadas. A 1011 é
incremental justamente para corrigir bancos que já registraram uma versão anterior
da 1009. **O executor ordena nomes lexicograficamente:** as migrations
`1000`–`1011` vêm antes de `999_*` em uma instalação limpa. `1002` depende da
fundação de parceiros e das tabelas sociais
anteriores; `1003`/`1004` reforçam constraints de `1002`. Nenhuma delas depende
de `999_profile_customization.sql`. Não renomeie migrations aplicadas. Os comandos
de provisionamento não executam migrations.

## Provisionamento operacional

Executar no backend, com `DATABASE_URL` configurada e a migration já aplicada.
O ambiente continua sendo carregado por `load-env.mjs`. Nenhuma chave de parceiro
precisa estar em variáveis do frontend ou em arquivos versionados.

```bash
npm run partners:admin -- create-partner --slug minha-empresa --name "Minha empresa"

npm run partners:admin -- create-application \
  --partner <partner-uuid> --slug ticketing --name "Integração ticketing" \
  --scopes status:read,events:read,events:write \
  --requests-per-minute 120

npm run partners:admin -- issue-key \
  --application <application-uuid> --label "Servidor principal" \
  --scopes status:read,events:read --expires-at 2027-12-01T00:00:00Z

npm run partners:admin -- revoke-key --key <credential-uuid>

npm run partners:admin -- rotate-key \
  --key <credential-uuid> --expires-at 2027-12-01T00:00:00Z

npm run partners:admin -- set-application-status \
  --application <application-uuid> --status disabled

npm run partners:admin -- set-partner-status \
  --partner <partner-uuid> --status disabled
```

Datas acima são exemplos; a validade precisa estar no futuro e incluir fuso.
`active` reativa uma empresa/aplicação, mas não reativa chaves revogadas.
Vínculos com tribos sociais não são provisionados pelo CLI nem por uma API key.
Eles exigem sessão social e confirmação do moderador atual na área de gestão da
tribo. A aplicação precisa ter `organizers:write` e o recurso provisional precisa
pertencer a ela. Tribos sociais vinculadas são somente leitura pelas rotas B2B2C.

A criação de empresa é idempotente pelo slug. A criação de aplicação é
idempotente por `(partner_id, slug)`. Mesma identidade e dados diferentes
retornam `identity_conflict`, sem sobrescrever informações. Chamadas concorrentes
convergem para um registro e uma entrada de auditoria. Revogar e definir o mesmo
estado novamente não duplicam auditoria.

Emissão de chave é uma operação explícita: cada emissão cria uma nova credencial.
A saída de emissão/rotação contém `apiKey` **uma única vez**. Guarde-a no gerenciador
de segredos do servidor parceiro; não envie a saída para logs ou ao navegador.
Não há recuperação do segredo. Rotação revoga a chave anterior e emite a nova
na mesma transação; duas rotações concorrentes da mesma chave têm somente um
sucesso. Para uma transição com sobreposição, emita outra chave, configure o
servidor parceiro e então revogue a anterior.

## Autenticação e status

```bash
curl https://<host-da-tribes>/api/v1/partners/status \
  -H "Authorization: Bearer <api-key>"
```

```json
{
  "ok": true,
  "apiVersion": "v1",
  "partner": {
    "id": "<partner-uuid>",
    "slug": "minha-empresa",
    "name": "Minha empresa",
    "status": "active",
    "createdAt": "2026-11-27T12:00:00.000Z",
    "updatedAt": "2026-11-27T12:00:00.000Z"
  },
  "application": {
    "id": "<application-uuid>",
    "slug": "ticketing",
    "name": "Integração ticketing",
    "status": "active",
    "requestsPerMinute": 120
  },
  "credential": {
    "id": "<credential-uuid>",
    "expiresAt": "2027-12-01T00:00:00.000Z"
  },
  "scopes": ["events:read", "status:read"]
}
```

O endpoint exige `status:read` e não aceita parâmetros de consulta. Empresa e
aplicação são derivadas exclusivamente da credencial. Não aceita cookie de
sessão, chave em URL ou chamadas com `Origin` de navegador. Não oferece CORS.
Em produção, usar HTTPS. As rotas sociais continuam exigindo suas próprias sessões.

As chaves usam 32 bytes aleatórios, identificador público e SHA-256 armazenado
no banco. A alta entropia permite hash rápido, sem derivação de senha. Comparação
do hash usa `timingSafeEqual`. Toda chamada verifica validade, revogação, estado
da empresa/aplicação e a interseção entre escopos da aplicação e da credencial.

Escopos conhecidos: `status:read`, `events:read`, `events:write`,
`organizers:write`, `moderators:read`, `moderators:write`, `participants:write`,
`invitations:write` e `organizer-grants:read`. `organizers:write` continua limitado
aos recursos provisionais de tribos; `events:read`/`events:write` consultam e
alteram eventos provisionais. `organizer-grants:read` é um escopo separado para
consultar designações humanas. `participants:write` cria/cancela registros de
ingressos e renova segredos de resgate; não permite ler participantes. O escopo
`invitations:write` permanece reservado e não concede acesso às rotas sociais de
convites.

## Tribos e eventos provisionais

Todas as rotas exigem Bearer API key, sem `Origin` e sem parâmetros de consulta.
Empresa e aplicação vêm exclusivamente da credencial. As representações `PATCH`
são completas; o identificador externo consta na URL e não pode ser alterado.
Essas credenciais não autenticam as rotas sociais de consentimento listadas abaixo.

| Método e rota | Escopo | Comportamento |
|---|---|---|
| `POST /api/v1/partners/tribes` | `organizers:write` | Cria ou recupera tribo por parceiro, aplicação e identificador externo |
| `GET /api/v1/partners/tribes/{externalTribeId}` | `organizers:write` | Consulta recurso da aplicação autenticada |
| `PATCH /api/v1/partners/tribes/{externalTribeId}` | `organizers:write` | Atualiza tribo provisional; tribo social vinculada é somente leitura |
| `GET /api/v1/partners/tribes/{externalTribeId}/organizer-grants` | `organizer-grants:read` | Lista designações ativas apenas enquanto vínculo social e membership do beneficiário estiverem ativos |
| `POST /api/v1/partners/events` | `events:write` | Cria/recupera evento por idempotência |
| `GET /api/v1/partners/events/{externalEventId}` | `events:read` | Consulta somente evento pertencente à aplicação autenticada |
| `PATCH /api/v1/partners/events/{externalEventId}` | `events:write` | Atualiza dados; com participantes, datas só podem ser remarcadas antes do término |
| `POST /api/v1/partners/events/{externalEventId}/cancel` | `events:write` | Cancela o evento terminalmente; idempotente; bloqueia novos registros, resgates e entradas baseadas no evento |
| `POST /api/v1/partners/events/{externalEventId}/participants/{externalParticipantId}` | `participants:write` | Cria/recupera uma inscrição ou ingresso com segredo de resgate opaco |
| `PUT /api/v1/partners/events/{externalEventId}/participants/{externalParticipantId}/claim-token` | `participants:write` | Renova o segredo; validade de sete dias; segredo anterior deixa de valer |
| `DELETE /api/v1/partners/events/{externalEventId}/participants/{externalParticipantId}` | `participants:write` | Cancela o ingresso terminalmente; idempotente |

A rota de cancelamento global não aceita parâmetros de consulta; se enviados,
responde `400 invalid_payload`.
Depois do término de um evento com participantes, `startsAt` e `endsAt` ficam
imutáveis (`409 event_schedule_locked`); atualizações dos demais metadados seguem
disponíveis até um cancelamento terminal. Eventos sem participantes mantêm a regra
anterior de remarcação.

Exemplo de provisionamento anterior à criação da conta do organizador:

```bash
curl https://<host>/api/v1/partners/tribes \
  -H 'Authorization: Bearer <api-key>' -H 'Content-Type: application/json' \
  -d '{"externalTribeId":"clube-42","name":"Clube 42","description":"Comunidade de jogos de tabuleiro.","category":"Jogos","format":"Presencial","city":"Belo Horizonte"}'

curl https://<host>/api/v1/partners/events \
  -H 'Authorization: Bearer <api-key>' -H 'Content-Type: application/json' \
  -d '{"externalEventId":"evento-2027-01","externalTribeId":"clube-42","title":"Noite de jogos","description":"Encontro mensal.","startsAt":"2027-01-20T19:00:00-03:00","location":"Espaço parceiro","cost":"Gratuito","maxAttendees":30}'
```

`POST` responde `201` na criação e `200` ao recuperar a mesma identidade com
dados equivalentes. A constraint `UNIQUE (partner_id, external_event_id)` resolve
corridas entre requisições e instâncias. O mesmo identificador com payload
incompatível responde `409 identity_conflict`, sem sobrescrever o registro. Outra
aplicação, inclusive do mesmo parceiro, recebe `404` e não pode consultar, editar
ou assumir o recurso. Identificadores iguais de parceiros diferentes são isolados.

Eventos associam-se a tribos da mesma aplicação por `externalTribeId`. Para usar
tribo social existente, o parceiro primeiro provisiona sua tribo e então o
moderador aprova o vínculo na sessão social. Criar/atualizar recursos provisionais
não escreve em `feed_items`, `tribe_events`, participações, notificações ou
convites. A Etapa 3 não publica nem sincroniza recursos sociais.

### Participantes, ingressos e consentimento social

O parceiro registra somente a identidade externa do ingresso e um segredo de
resgate. Um segredo deve conter 32 bytes aleatórios gerados por CSPRNG e codificados
em base64url (43 caracteres). A Tribes armazena SHA-256, nunca o valor em claro.
Não enviar nome, e-mail ou UUID Tribes no payload. Não registrar o segredo em logs
do sistema do parceiro. A Tribes não processa pagamentos, reembolsos, check-in ou
inventário; o parceiro cria o registro após confirmar sua própria inscrição/venda
e entrega o segredo ao titular por seu canal seguro. Repetir a criação com a mesma
identidade e o mesmo segredo é idempotente; outro payload para a mesma identidade
retorna `409`. Renovar usa um novo segredo; repetir a renovação com o mesmo segredo
não estende novamente seu prazo. Cada segredo vale sete dias.

Os endpoints de participante são server-to-server e exigem `participants:write`.
O evento deve pertencer à aplicação autenticada, estar ativo e não ter terminado.
Um evento cancelado é terminal e não aceita registros nem renovações. Eventos com
qualquer registro (inclusive cancelado) não podem mudar de tribo provisional:
`PATCH` retorna `409 event_has_participants`. Cancelar um ingresso ou evento nunca
remove uma membership existente. Uma nova compra/titularidade usa novo
`externalParticipantId`; registros cancelados não são reativados.

A pessoa abre o segredo em `/ingressos/resgatar`. O token é transportado no
fragmento, removido imediatamente da barra de endereço e mantido somente em
`sessionStorage` temporário durante autenticação/resgate; requisições usam
`Referrer-Policy: no-referrer`. A página não envia eventos de analytics. O backend
exige sessão social, mostra parceiro, aplicação, evento e tribo e emite um desafio
de cinco minutos vinculado à conta. A prévia **não consome** o segredo. Somente a
confirmação bem-sucedida consome o segredo e associa o registro ao `user.id` da
sessão, atomicamente. Repetir a confirmação com o mesmo desafio e usuário retorna
sucesso; outra conta não pode reutilizá-la. Se a prévia expirar, o parceiro renova
o segredo e a pessoa recomeça. Cada desafio armazena a versão e o hash exatos
validados na prévia. Confirmação e rotação serializam pelos locks do evento e do
participante; a confirmação rejeita versões antigas, invalidando todas as prévias
pendentes da versão anterior. Essas prévias ficam inelegíveis e são removidas pelo
job normal de expiração. Hashes anteriores permanecem como tombstones e não podem
ser atribuídos a outro participante.

Se o cadastro por e-mail for concluído em outra aba do mesmo navegador, mantenha
aberta a aba original de resgate: a confirmação de cadastro a notificará sem enviar
o segredo entre abas, e o resgate continuará automaticamente. `BroadcastChannel` é
o mecanismo preferencial; sem suporte, usa-se um marcador de autenticação sem dados
secretos em `localStorage` e, se o storage estiver indisponível, a aba original
consulta a sessão autenticada do mesmo navegador. O segredo permanece somente no
`sessionStorage` daquela aba.

Vincular o ingresso **não entra na tribo**. O usuário deve iniciar separadamente
`POST /api/me/partner-participants/{participantId}/join-tribe`. O backend revalida
registro, evento, aplicação e o mesmo ciclo ainda ativo de vínculo social. Usa as
regras atuais de membership; tribo privada ainda requer a senha ou o convite social
válido. O fluxo não escreve em `event_attendees`/`event_waitlist`, não cria
`tribe_invitations`, não envia notificação e não dá permissões ao parceiro.

Rotas autenticadas pela sessão social:

| Método e rota | Resultado |
|---|---|
| `POST /api/partner-participants/preview` | Valida segredo ativo sem consumi-lo; retorna prévia e desafio de cinco minutos |
| `POST /api/partner-participants/confirm` | Consome segredo e desafio atomicamente e associa à conta autenticada, sem membership |
| `GET /api/me/partner-participants` | Lista somente ingressos associados à própria conta |
| `DELETE /api/me/partner-participants/{participantId}` | Desvincula da conta terminalmente; não cancela compra nem remove membership |
| `POST /api/me/partner-participants/{participantId}/join-tribe` | Entrada explícita, sujeita às regras atuais de acesso |

Cancelar o ingresso antes do resgate invalida o segredo. Cancelar após o vínculo
impede uma entrada futura baseada naquele ingresso, mas mantém a associação e o
histórico visíveis à própria pessoa até desvinculação/retenção. Cancelar o evento
bloqueia registros, confirmações ainda não concluídas e entradas futuras. Uma
membership já ativa permanece; a saída continua sob controle do usuário. Revogar
o vínculo social bloqueia resgate/entrada novos; autorizar outro ciclo não reativa
uma associação antiga ao ciclo anterior. O participante pode desvincular a
associação na conta Tribes; isso não altera o ingresso no parceiro nem membership.
O unlink é terminal para aquele ciclo: o mesmo ingresso não pode ser associado
novamente, inclusive pela repetição idempotente do desafio de confirmação.

Retenção: prévias expiradas são eliminadas no job diário quando passam sete dias da
expiração. Noventa dias após o término/início do evento, a anonimização remove
registro, identificador externo, associação à conta e linhas individuais de
auditoria. Restam somente contagens agregadas sem identificador individual, como
descrito na seção de retenção acima. Tombstones dos hashes de segredo são mantidos
indefinidamente, sem ponteiro para participante após o prazo de retenção. Exclusão
da conta aplica `SET NULL` aos atores do histórico antes do prazo, sem alterar as
regras de retenção.

Ordem de locks: operações sociais de resgate/entrada/revogação/exclusão adquirem
primeiro o lock da tribo social, depois aplicação/parceiro, tribo provisional e
ciclo de vínculo, evento e registro de participante; sessões são validadas na
transação. Operações B2B que alteram ingressos bloqueiam evento antes do registro.
Cancelamento global bloqueia somente o evento e não tenta adquirir locks sociais
ou de participante. Assim, cancelamento versus resgate/entrada serializa no evento;
revogação/exclusão serializa na tribo social, sem inversão de ordem.

### Consentimento e revogação por sessão social

O moderador usa a página autenticada `/minhas-tribos/{tribeId}`. A interface
solicita prévia por aplicação e identificador externo, mostra o parceiro/aplicação
obtidos do banco, a tribo exata e os dados que ficarão visíveis, e só então permite
confirmar. Para tribos privadas, há uma confirmação adicional e o backend exige
que a tribo continue privada e o consentimento continue válido no momento da
confirmação. A API não aceita `approved_by`, UUID de usuário ou e-mail como prova.

| Método e rota social | Autenticação/autoridade | Resultado |
|---|---|---|
| `GET /api/tribes/{tribeId}/partner-links` | Cookie `tribes_session`; moderador atual, membro ativo e integrações ativas | Lista vínculos/histórico apenas de parceiro e aplicações ativos |
| `POST /api/tribes/{tribeId}/partner-links/preview` | Cookie `tribes_session`; moderador atual e membro ativo | Valida app e recurso provisional e emite token de confirmação de 5 minutos, ligado ao usuário, tribo, app e recurso exatos |
| `POST /api/tribes/{tribeId}/partner-links/confirm` | Cookie `tribes_session`; mesmo usuário/moderador e membro ativo | Consome o token uma única vez, revalida todos os dados e registra autorizador/horário |
| `DELETE /api/tribes/{tribeId}/partner-links/{applicationId}/{externalTribeId}` | Cookie `tribes_session`; moderador atual e membro ativo | Revoga apenas o vínculo daquela aplicação, registra revogador/horário e é idempotente |
| `GET /api/tribes/{tribeId}/partner-grants` | Cookie `tribes_session`; moderador atual e membro ativo | Lista concessões e histórico, inclusive grants ligados a aplicações desativadas ou vínculos revogados |
| `POST /api/tribes/{tribeId}/partner-grants` | Cookie `tribes_session`; moderador atual e membro ativo | Concede `organizer.manage` a um membro ativo para um recurso provisional vinculado |
| `DELETE /api/tribes/{tribeId}/partner-grants/{grantId}` | Cookie `tribes_session`; moderador atual e membro ativo | Revoga somente o grant; disponível mesmo com aplicação inativa ou escopo removido |

Essas rotas são sociais, não B2B2C: exigem a sessão social e não aceitam Bearer
partner key. O servidor obtém o usuário da sessão, confere `moderator_id` e a
associação ativa à tribo dentro da transação. Parceiro e aplicação são carregados
do banco; uma aplicação desativada não pode receber novos vínculos, listar vínculos
ativos ou revogá-los. Um operador precisa reativar a aplicação para que o moderador
possa revogar a autorização. Prévia expirada, dados alterados, usuário diferente ou
moderador substituído exigem uma nova prévia. O token só é armazenado como hash.

Após revogação, consultas B2B2C continuam retornando somente os metadados próprios
do parceiro; nome/descrição/cidade sociais deixam de ser consultáveis também nos
objetos de eventos. Membros, conteúdo, eventos sociais e moderação não são
alterados. O histórico guarda uma linha por ciclo de autorização; nova autorização
não apaga ciclos anteriores.

### Grants humanos e designação de organizadores

O moderador concede o grant a um membro selecionado por `beneficiaryUserId`. Esse
UUID é apenas um seletor enviado pelo cliente: o backend resolve o usuário e exige
membership ativa na tribo social, aplicação ativa com `organizer-grants:read` e
vínculo ativo do recurso provisional com a tribo. O concedente sempre vem da sessão
social validada; nenhum ID do corpo é aceito como prova de autorização.

`organizer.manage` significa exclusivamente que o usuário está designado como
organizador humano daquele recurso provisional para a integração parceira. Não
permite editar recursos pela API, modificar tribos ou eventos sociais, publicar
conteúdo, convidar participantes, moderar tribos ou executar ações sociais. A API
parceira retorna apenas o UUID estável do beneficiário, o ID do grant, a capacidade
e o horário de concessão; nunca retorna nome ou e-mail. Não registrar esse UUID em
logs operacionais desnecessários.

Um grant tem histórico independente do vínculo. Revogar o vínculo não altera nem
remove o grant; enquanto ele estiver revogado, a API B2B retorna lista vazia e não
expõe beneficiários ou outros dados sociais. Um vínculo reautorizado só permite
consultar grants que permaneçam ativos e cujos beneficiários ainda tenham
membership ativa na mesma tribo social. A saída ou remoção do beneficiário da tribo
revoga automaticamente seus grants ativos com origem `membership_ended`; voltar
a ser membro não reativa grants anteriores. Excluir a tribo revoga os grants ativos
com origem `social_tribe_deleted`, preservando o histórico.

Concessões e revogações sociais permanecem disponíveis para o moderador atual
mesmo quando a aplicação está desativada ou perdeu `organizer-grants:read`. Nesses
estados, a aplicação não pode consultar grants nem executar operações B2B2C. A
revogação de grant não revoga o vínculo social, e a revogação do vínculo não altera
grants nem governança social.

## Erros

```json
{
  "error": "A credencial não possui a permissão necessária.",
  "code": "insufficient_scope",
  "requestId": "<request-uuid>"
}
```

| HTTP | Código | Significado |
|---|---|---|
| 400 | `invalid_payload` | Parâmetros não aceitos ou dados operacionais inválidos |
| 413 | `invalid_payload` | Corpo JSON excede o limite de 16 KiB |
| 401 | `invalid_credentials` | Chave ausente, incorreta, revogada, expirada ou integração desativada |
| 403 | `insufficient_scope` | Escopo necessário ausente |
| 403 | `server_to_server_only` | Chamada com origem de navegador |
| 404 | `route_not_found` | Endpoint de integração inexistente |
| 404 | `resource_not_found` | Recurso inexistente ou fora da aplicação autenticada |
| 404 | `participant_not_found` | Registro não encontrado no tenant autenticado |
| 409 | `identity_conflict` | Identificador externo já associado a outros dados |
| 409 | `linked_tribe_read_only` | Tribo social vinculada não pode ser alterada pela API do parceiro |
| 409 | `event_has_participants` | Evento com registros não pode ser reatribuído a outra tribo provisional |
| 409 | `event_schedule_locked` | Datas de evento com participantes não podem ser alteradas após o término |
| 409 | `event_cancelled` / `event_not_active` | Evento terminalmente cancelado ou encerrado |
| 409 | `participant_cancelled` / `participant_already_claimed` | Registro cancelado ou segredo já utilizado |
| 409 | `claim_token_conflict` | Segredo de resgate já pertence a outro registro |
| 405 | `method_not_allowed` | Método incorreto; inclui `Allow` |
| 429 | `rate_limit_exceeded` | Orçamento da aplicação excedido |
| 429 | `authentication_rate_limit` | Excesso de autenticações inválidas |
| 503 | `partner_api_unavailable` | Falha interna, com resposta e log sanitizados |

Erros das rotas sociais de consentimento são separados e não usam o formato
`requestId` da API Bearer:

| HTTP | Código | Significado |
|---|---|---|
| 400 | `invalid_payload` | Payload inválido ou confirmação privada ausente |
| 401 | `social_session_required` | Sessão social ausente, inválida ou expirada |
| 404 | `tribe_not_found` / `resource_not_found` | Sem moderação/associação ativa ou recurso fora da aplicação |
| 404 | `beneficiary_not_active_member` | Beneficiário inexistente ou sem membership ativa na tribo |
| 404 | `partner_application_not_found` | Aplicação inexistente ou inativa |
| 409 | `social_link_exists` | Vínculo já ativo ou concorrente |
| 409 | `partner_application_disabled` | Não é possível listar vínculos ativos de uma integração desativada |
| 409 | `partner_application_scope_missing` | A aplicação não tem o escopo exigido pela operação social |
| 409 | `social_link_preview_expired` | Prévia expirada, consumida ou pertencente a outra sessão/tribo |
| 409 | `social_link_preview_changed` | Dados da prévia mudaram antes da confirmação |
| 409 | `social_link_integrity_error` | Ponteiro e histórico de autorização divergentes |
| 404 | `participant_claim_invalid` / `participant_not_found` | Segredo inválido, expirado, cancelado ou recurso indisponível |
| 409 | `participant_preview_expired` / `participant_preview_changed` | Desafio vencido, usado por outra conta ou dados/autorização alterados |
| 409 | `participant_already_claimed` / `participant_not_eligible` | Registro já associado ou não elegível para entrada futura |
| 403 | `private_tribe_access_denied` | Regras atuais da tribo privada não foram atendidas |
| 400 | `private_tribe_consent_required` | Confirmação explícita de dados privados ausente |
| 405 | `method_not_allowed` | Método incorreto; inclui `Allow` |
| 429 | `rate_limit_exceeded` | Limite da API social atingido |

Respostas têm `Cache-Control: no-store` e `X-Request-Id` gerado pelo backend.
Os erros operacionais do CLI usam `error` e `code`, com saída não zero.

## Concorrência, limites e auditoria

O limite válido é por aplicação, em janelas fixas de minuto, compartilhado entre
todas as chaves e réplicas. Uma única linha por aplicação limita o crescimento
da tabela; o contador é atualizado atomicamente. Respostas `429` incluem
`Retry-After`. Operações autorizadas que falham consomem o orçamento, enquanto
as alterações de recursos são revertidas por savepoint. Falhas de autenticação/escopo não consomem o orçamento da aplicação;
tentativas inválidas são limitadas em memória por IP do socket, com mapa limitado
e expiração. Não se confia em `X-Forwarded-For` enviado pelo chamador. Atrás de um
proxy, esse limitador inicial pode compartilhar o IP do proxy; a proteção por
aplicação permanece independente.

`withAuthorization(token, requiredScopes, work)` mantém locks de empresa,
aplicação e credencial até terminar `work(client, principal)`. Novas mutações
devem usar **esse mesmo client e transação**, filtrando recursos por
`principal.partnerId` e `principal.applicationId`; não basta autenticar e depois
executar uma mutação fora da transação. Revogação/desativação espera operações
já autorizadas terminarem e impede as seguintes.

As rotas sociais de consentimento seguem a sessão existente e realizam sua própria
transação: revalidam a sessão social, bloqueiam tribo/moderação e o recurso do
parceiro, registram o histórico e a auditoria antes do commit. Leituras B2B2C
compartilham o lock do vínculo, de modo que uma revogação espera leituras em curso
terminarem e bloqueia as seguintes.

No fluxo de participantes, sessões são validadas dentro da transação. A ordem de
locks é tribo social, aplicação/parceiro, tribo provisional e ciclo de vínculo,
evento e registro do participante. Cancelar/renovar registro bloqueia evento antes
do participante; cancelar evento bloqueia apenas o evento. A atualização de evento
e o job de retenção também serializam no lock da linha de evento antes de decidir
datas ou o marco. Portanto cancelamento global serializa com resgate/entrada sem
inverter a ordem social; a exclusão social e a revogação começam pela tribo social,
na mesma ordem das operações de resgate/entrada.

Leituras B2B de grants também bloqueiam o recurso, o ciclo ativo do vínculo e a
membership do beneficiário antes de retornar `beneficiaryUserId`. A saída do membro
revoga grants e grava auditoria na mesma transação da mudança de membership.

A auditoria registra ações e timestamps na transação de provisionamento, vínculo,
revogação, rotação, ingresso e consentimentos. Não armazena segredo, e-mail, payload
livre ou corpo HTTP. O job diário remove prévias sete dias após a expiração e,
90 dias após `participant_retention_at`, agrega os fatos por parceiro/aplicação/evento/
ação e remove linhas individuais de histórico/auditoria. Cada execução bem-sucedida
registra timestamp, duração e quantidades sem PII/token; um advisory lock transacional
serializa execuções concorrentes. Tombstones dos segredos rotacionados continuam
pseudonimizados e sem prazo de expiração, conforme a finalidade e a limitação
documentadas acima. A outbox de eventos de domínio continua em etapa posterior.

## Testes isolados e regressões

Unitários (não exigem infraestrutura):

```bash
cd backend
npm test
```

Integrações completas, incluindo as suítes sociais existentes:

```bash
docker compose -p tribes-test -f compose.test.yaml build
docker compose -p tribes-test -f compose.test.yaml run --rm tests
docker compose -p tribes-test -f compose.test.yaml down
```

O ambiente de testes não publica portas, não monta `.env` nem volumes reais e
usa PostgreSQL, MailHog e armazenamento S3 efêmeros próprios. A imagem ignora
arquivos `.env`. Não use esse arquivo para executar a aplicação de produção.

As integrações B2B2C executam somente com `TRIBES_PARTNER_TEST_DATABASE_URL`
explicitamente configurada e com banco chamado `tribes_partner_test`. Cada teste
usa schema temporário ou fixtures identificadas e removidas desse banco. Verificam migrations em instalação
limpa e sobre dados sociais existentes, isolamento, hash, escopos, estados,
revogação, rotação, idempotência concorrente, conflitos, propriedade por aplicação,
prévia não reutilizável, consentimento por moderador, privacidade, revogação,
histórico, grants humanos, isolamento entre parceiros/aplicações, revogação do
vínculo sem revogação do grant, membership encerrada, exclusão de tribo, limites
de escopo e ausência de publicações ou alterações sociais por grants provisionais.
Participantes também cobrem consumo do segredo somente na confirmação, idempotência
por usuário/desafio, regras de tribo privada, cancelamento global/individual,
reparenting bloqueado, ausência de membership automática, não remoção de membros,
isolamento entre aplicações e anonimização após retenção.

## Próximas etapas

Publicação/sincronização social, descoberta pública e outbox permanecem fora da
Etapa 4. `invitations:write` continua reservado; parceiros não criam convites
sociais. Grants humanos permanecem independentes do ingresso e dos fluxos de
membership.
