# Produção e segurança

O `compose.yaml` continua sendo o ambiente local de desenvolvimento. Ele não deve ser publicado diretamente na internet.

## Subir a configuração de produção

1. Copie `.env.production.example` para `.env.production`.
2. Substitua todos os valores de exemplo por credenciais fortes e reais.
3. Defina `FRONTEND_URL` com a origem HTTPS principal exata (protocolo + domínio + porta, sem caminho). O Compose de produção já permite `www.tribeyourself.com.br` e `tribeyourself.com.br` por padrão.
4. Se o frontend também responder por outros domínios, informe as origens adicionais em `FRONTEND_ORIGINS`, separadas por vírgula. Não use caminhos nem curingas.
5. Configure uma chave de API do Resend e um bucket privado no Cloudflare R2.
6. Garanta que o proxy HTTPS termine TLS e encaminhe o tráfego para `127.0.0.1:4317`.
7. Execute:

```bash
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

O backend, PostgreSQL e seus dados de armazenamento não têm portas publicadas no host. O MailHog e o RustFS local não fazem parte do Compose de produção. Os containers de produção executam como usuário não-root e usam filesystem somente leitura, com diretórios temporários em tmpfs.

**Atenção:** mantenha o bucket R2 privado. Não habilite acesso público ao bucket. Use uma senha PostgreSQL longa e codifique caracteres especiais em formato URL na variável `DATABASE_URL`. Não versione o arquivo `.env.production`.

## Controles implementados

- Respostas uniformes na solicitação de redefinição de senha, evitando enumeração de e-mails.
- Validação de `Origin` para requisições que alteram dados.
- Limites de requisições por conta/token e por usuário autenticado.
- Cabeçalhos de segurança HTTP e CSP no frontend.
- Limites de dimensões e quantidade de pixels nas imagens enviadas.
- Containers de produção não-root, sem serviços de desenvolvimento expostos.
- CI para testes, lint, build e auditoria de dependências.

## Limitações que ainda exigem configuração/implementação

- Os limitadores atuais são em memória. Em implantação com múltiplas réplicas, mover os contadores para Redis ou armazenamento compartilhado.
- O proxy de produção deve controlar os cabeçalhos de encaminhamento e não expor diretamente a porta do backend.
- A política de privacidade por campo do perfil ainda precisa ser implementada.
- A auditoria automatizada de dependências não substitui revisão de atualizações, imagens Docker e configuração do provedor de nuvem.
- Testes de integração dependem de PostgreSQL, MailHog e armazenamento configurados; a CI executa testes unitários e pula integrações que não tenham ambiente configurado.
