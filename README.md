# Tribes — Landing Page e Feed Social (TP4 · Empreendimentos em Informática)

Landing Page de validação (Smoke Test + Protótipo Interativo) para a rede social **Tribes**, focada em conectar pessoas a partir de interesses em comum e descomplicar a organização de encontros presenciais, híbridos e online.

## O que esta entrega contempla

1. **Proposta de Valor e Diagnóstico do Problema**: contraste direto entre o isolamento/ruído das redes atuais e grupos de mensagens (WhatsApp, Discord, Instagram) e a organização por comunidades em escala humana da Tribes.
2. **Mockup Interativo no Hero**: demonstração funcional do *Card de Encontro Fixado* com confirmação de presença (RSVP) em 1 clique separada do chat.
3. **Explorador Interativo de Tribos (`#explorar`)**: filtragem por hobby/interesse, formato (`Presencial`, `Híbrido`, `Online`), busca textual e selo **Aberto para iniciantes**, com modal detalhado de cada tribo.
4. **Segmentos do Modelo de Negócios (`#segmentos` e `#planos`)**:
   - **Membros Exploradores (B2C Gratuito)**
   - **Organizadores de Comunidades (Freemium / Tribes Organizador Pro)**
   - **Points & Espaços Parceiros Verificados (B2B Local — cafés, ludotecas, arenas, livrarias)**
5. **Cadastro de contas**: criação por link enviado ao e-mail e ativação da conta após confirmação.
6. **Painel de Métricas (`/metricas`)**: usuários ativos DAU/WAU/MAU, cadastros, funil anônimo da landing page e atividade real do produto, com acesso administrativo restrito.
7. **Área autenticada da rede social**: feed cronológico de publicações e eventos das tribos do usuário, imagens em publicações, busca e participação em tribos, criação de comunidades, curtidas e comentários.

## Organização do projeto

- `frontend/`: aplicação Next.js, componentes, assets e configuração do container de frontend.
- `backend/`: API Node.js, acesso ao PostgreSQL e configuração do container de backend.
- `backend/migrations/`: esquema versionado das contas, tribos, participações, publicações/eventos e interações.
- PostgreSQL roda como o serviço `database` do Compose e persiste os dados da aplicação no volume `postgres_data`.
- Imagens de publicações e avatares são armazenadas em um bucket S3 privado; PostgreSQL guarda referências, MIME e tamanho. Em desenvolvimento, o serviço RustFS fornece armazenamento S3 local no volume `rustfs_data`.
- A Landing Page continua em `/` para visitantes. Cadastro e login levam à área autenticada, que oferece feed, busca e criação de tribos.
- Contas, sessões, tribos, participações, publicações/eventos, curtidas e comentários são persistidos no PostgreSQL. O painel usa agregados anônimos para visitantes e atividade autenticada para usuários ativos; não expõe dados pessoais.

## Tecnologias

- Next.js (App Router) + TypeScript
- Node.js HTTP API
- PostgreSQL
- Tailwind CSS v4 + shadcn/ui
- Lucide Icons
- Cadastro por link de e-mail, senhas derivadas por scrypt e sessões próprias com cookie `HttpOnly`; sessões renovam até 30 dias de inatividade e expiram no máximo 90 dias após o login

## API de parceiros (B2B2C)

A API server-to-server de parceiros oferece empresas, aplicações, API keys com
hash, escopos, validade/revogação, status e provisionamento isolado de tribos e
eventos antes da conta do organizador. Esses recursos não são publicados no feed
social. Moderadores sociais podem designar membros ativos como organizadores
humanos de recursos provisionais vinculados; a integração consulta essas
designações com o escopo `organizer-grants:read`. A capacidade `organizer.manage`
é somente uma designação para a aplicação e não concede escrita, moderação ou
ações sociais na Tribes. Veja o provisionamento operacional e contrato em
[backend/PARTNER_API.md](backend/PARTNER_API.md) e
[OpenAPI](backend/partner-openapi.json). As sessões e funcionalidades sociais
continuam independentes. Os testes completos rodam em ambiente efêmero e isolado
com `compose.test.yaml`, conforme a documentação da API.

## Como executar com Docker

```bash
docker compose up
```

O Compose inicia frontend, backend, PostgreSQL, MailHog e RustFS. As portas locais são `4317` (frontend), `8026` (MailHog), `9000` (API S3 do RustFS) e `9001` (console RustFS). O bucket privado `tribes-media` é criado automaticamente com credenciais exclusivas de desenvolvimento. O Next.js encaminha as chamadas `/api/*` para a API. Acesse `http://localhost:4317` para a Landing Page; usuários podem criar conta em `/cadastro` ou entrar em `/entrar`. No cadastro, a pessoa informa o e-mail e recebe um link; ao abri-lo, define o nome e a senha, e entra automaticamente no feed. No login, o link **Esqueci minha senha** envia instruções por e-mail para contas cadastradas e informa quando o e-mail não está cadastrado; após escolher a nova senha pelo link, a pessoa também entra automaticamente no feed. Em desenvolvimento, veja os e-mails capturados em `http://localhost:8026`. Após autenticar, a aplicação abre `/feed`, com atalhos para explorar e criar tribos. O painel de métricas fica em `/metricas`. As alterações no frontend e no backend são refletidas durante o desenvolvimento.

Para habilitar o autocompletar e os mapas dos locais de eventos, copie `.env.example` para `.env` na raiz e preencha `MAPS_API` com uma chave Geoapify. Em produção, configure `MAPS_API` no serviço backend; a API entrega a chave ao frontend em runtime para carregar sugestões e tiles. Como ela será usada pelo navegador, restrinja-a por domínio e pelas APIs permitidas no painel Geoapify. Sem a chave, os locais ainda podem ser digitados manualmente, mas mapas e autocompletar ficam indisponíveis.

O backend carrega `backend/.env` quando o arquivo existe. Para conectar uma instância local ao R2 real, copie `backend/.env.example` para `backend/.env` e preencha as credenciais. Sem esse arquivo, o Compose usa RustFS e credenciais de desenvolvimento. `.env` é ignorado pelo Git e excluído do contexto Docker.

### Painel de métricas em produção

O painel `/metricas` e `GET /api/admin/metrics` exigem uma sessão autenticada e um e-mail autorizado no backend. Configure `METRICS_ADMIN_EMAILS` no serviço backend com uma lista separada por vírgulas (por exemplo, `admin@exemplo.com,produto@exemplo.com`). Cada pessoa precisa criar e confirmar a própria conta; a allowlist concede o acesso e pode ser alterada sem modificar o código. No Compose local, defina a variável em `.env` na raiz.

Eventos públicos são recebidos em `POST /api/analytics/events`; a API aceita somente tipos/categorias predefinidos, aplica limite de requisições e não devolve totais. O identificador first-party aleatório expira em 24 horas e é armazenado apenas como hash; registros anônimos antigos são eliminados após 100 dias. Atividade autenticada atualiza `users.last_seen_at` no máximo a cada cinco minutos. O painel apresenta DAU (24h), WAU (7d), MAU (30d), cadastros, aquisição e ações reais do produto. A migração inicial estabelece um novo baseline: os contadores antigos, que incluem dados de demonstração, não são usados nem apagados.

Por padrão, `EMAIL_PROVIDER=mailhog` envia os e-mails ao MailHog local, disponível em `http://localhost:8026`. Para testar com o Resend, configure somente no `backend/.env`:

```dotenv
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_sua_chave_privada
EMAIL_FROM="Tribes <onboarding@resend.dev>"
FRONTEND_URL=http://localhost:4317
```

Reinicie o backend depois de alterar as variáveis. `onboarding@resend.dev` é um remetente de teste e não deve ser usado em produção; nesse modo, o Resend restringe os destinatários permitidos (por exemplo, ao endereço da própria conta enquanto não houver domínio verificado). A aplicação não tenta contornar essas regras e informa falha se o Resend recusar o envio. Para voltar ao MailHog, defina `EMAIL_PROVIDER=mailhog`; no Compose o SMTP é `smtp://mailhog:1025`. A chave do Resend é privada: mantenha-a apenas no backend e nunca a configure no frontend ou em arquivos versionados.

Para produção, crie um token S3 em **Cloudflare Dashboard → R2 → Manage R2 API Tokens** com permissões de leitura e gravação limitadas ao bucket privado `tribes-media`. Configure no serviço backend do Render `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME=tribes-media` e `R2_ENDPOINT=https://88f67df82791b16d9aa1f5c4be6a2685.r2.cloudflarestorage.com`. O ID da conta e as chaves são obtidos na Cloudflare; nunca configure essas variáveis no frontend. Não habilite Public Development URL nem domínio público para este bucket. O backend autoriza a solicitação e redireciona para uma URL assinada de leitura com validade de cinco minutos.

## Feed e API social

- `GET /api/auth/me`, `POST /api/auth/register` (solicita link por e-mail), `POST /api/auth/register/complete` (cria a conta e inicia a sessão), `POST /api/auth/password-change` (altera a senha atual e encerra outras sessões), `POST /api/auth/password-reset` (solicita redefinição de senha por e-mail), `POST /api/auth/password-reset/complete` (altera a senha e inicia uma nova sessão), `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/feed?tribeId=<uuid>&cursor=<cursor>&limit=20` — timeline cronológica paginada por cursor; o filtro de tribo é validado pela associação ativa do usuário.
- `GET /api/tribes?q=<busca>&mine=true` e `POST /api/tribes`; `POST /api/tribes/:id/join` e `DELETE /api/tribes/:id/membership`
- `POST /api/tribes/:id/posts` e `POST /api/tribes/:id/events`
- Publicações e perfis podem incluir uma imagem JPEG, PNG ou WebP de até 5 MB. O backend confere o tipo real do arquivo, gera object keys e grava imagens no bucket privado. Imagens de publicações só são assinadas para leitura após validar sessão e associação ativa à tribo; avatares continuam disponíveis apenas a usuários autenticados.
- `POST|DELETE /api/content/:id/like`, `GET|POST /api/content/:id/comments` e `PATCH|DELETE /api/comments/:id`

As migrações são aplicadas no início do backend e registradas em `schema_migrations`. A migration `008_r2_image_references.sql` é aditiva: permite novas imagens referenciadas no R2 e mantém os binários antigos no PostgreSQL. Após configurar o bucket e as credenciais, transfira os arquivos antigos com `docker compose exec backend npm run migrate:legacy-images`. O comando só associa uma object key após comparar tamanho, MIME detectado e SHA-256 do objeto copiado; em falhas, mantém a imagem original. Ele não apaga os binários do banco. Para verificar o progresso:

```sql
SELECT 'publicações' AS tipo, count(*) AS sem_referencia
FROM content_images WHERE image_key IS NULL
UNION ALL
SELECT 'avatares', count(*)
FROM user_profile_images WHERE image_key IS NULL AND is_deleted = FALSE;
```

A remoção dos binários antigos fica para uma migration posterior, depois de validar as cópias e com aprovação explícita. Os links de cadastro e redefinição de senha expiram em 30 minutos, só podem ser usados uma vez, e seus tokens são armazenados como hash. Ao alterar a senha no perfil, a sessão atual é mantida e as demais são encerradas; ao redefinir a senha por e-mail, as sessões anteriores são encerradas e uma nova é iniciada. O provedor de e-mail é selecionado por `EMAIL_PROVIDER` (`mailhog` ou `resend`); para Resend, configure `RESEND_API_KEY`, `EMAIL_FROM` e `FRONTEND_URL` no backend. Curtidas são únicas por usuário/conteúdo; comentários só podem ser alterados pelo autor. O feed, as tribos e as interações exigem sessão autenticada.

Para executar testes unitários do backend: `docker compose exec backend npm test`. Com o Compose ativo, os testes de integração contra PostgreSQL, API e RustFS são executados com `docker compose exec backend npm run test:integration`.

Para encerrar, pressione `Ctrl+C` ou execute `docker compose down` em outro terminal. Os dados do PostgreSQL são mantidos no volume `postgres_data`. Para atualizar dependências depois de alterar os manifests, atualize os volumes de dependências e recrie os containers:

```bash
docker compose down
docker compose run --rm --no-deps frontend npm ci
docker compose run --rm --no-deps backend npm ci
docker compose up --build
```

Para acompanhar os logs dos três serviços, use `docker compose logs -f`. Para apagar também os dados persistidos no banco, execute `docker compose down --volumes`.
