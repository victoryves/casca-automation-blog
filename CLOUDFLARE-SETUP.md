# Cloudflare Email Routing Setup

## Passo 1: Configure o Email Routing

1. Acesse [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Selecione seu domínio
3. Vá em **Email** > **Email Routing**
4. Clique em **Get Started** (se ainda não ativou)
5. Siga o wizard para verificar os registros DNS

## Passo 2: Crie o Endereço de Email

1. Na página de Email Routing, vá em **Destination addresses**
2. Adicione seu email pessoal (para testes iniciais)
3. Confirme o email de verificação que receberá

## Passo 3: Crie uma Rota para o Worker

1. Vá em **Email Routing** > **Routes**
2. Clique em **Create address**
3. Configure:
   - **Custom address**: `approve@seudominio.com` (ou o que preferir)
   - **Action**: Selecione **Send to a Worker**
   - **Worker**: (vamos criar no próximo passo)

## Passo 4: Crie o Email Worker

### 4.1 Instale Wrangler (CLI do Cloudflare)

```bash
npm install -g wrangler
```

### 4.2 Faça login

```bash
wrangler login
```

### 4.3 Deploy do Worker

No diretório do projeto:

```bash
cd cloudflare-worker
wrangler deploy
```

### 4.4 Configure as Variáveis de Ambiente

No Cloudflare Dashboard:

1. Vá em **Workers & Pages**
2. Selecione o worker `casca-email-worker`
3. Vá em **Settings** > **Variables**
4. Adicione:
   - `VERCEL_WEBHOOK_URL` = `https://casca-automation-blog.vercel.app/api/webhook/email`
   - `WEBHOOK_SECRET` = (o mesmo valor que você tem no `.env` local)

## Passo 5: Conecte o Worker à Rota de Email

1. Volte para **Email Routing** > **Routes**
2. Edite a rota que criou no Passo 3
3. Em **Worker**, selecione `casca-email-worker`
4. Salve

## Passo 6: Configure as Variáveis no Vercel

1. Acesse [Vercel Dashboard](https://vercel.com/dashboard)
2. Selecione o projeto `casca-automation-blog`
3. Vá em **Settings** > **Environment Variables**
4. Certifique-se que existe:
   - `WEBHOOK_SECRET` (mesmo valor do Worker)
   - `APPROVAL_EMAIL` (seu email que vai aprovar)

## Passo 7: Teste o Fluxo Completo

### 7.1 Envie um email de teste

No Mac Mini, rode:

```bash
npm run daily
```

Isso vai descobrir um artista e enviar um email.

### 7.2 Responda com "poste"

Quando receber o email, responda com a palavra exata:

```
poste
```

### 7.3 Verifique os logs

**No Cloudflare:**
1. Vá em **Workers & Pages**
2. Clique em `casca-email-worker`
3. Vá em **Logs** (tab superior)
4. Você deve ver os logs do processamento do email

**No Vercel:**
1. Vá no projeto
2. Clique em **Deployments** > última deployment
3. Clique em **View Function Logs**
4. Procure por logs do webhook

**No Hashnode:**
1. Acesse seu blog
2. Verifique se o artigo foi publicado

## Troubleshooting

### Email não chega no Worker

- Verifique se os registros DNS do Email Routing estão corretos
- Confirme que o endereço de destino foi verificado
- Verifique se a rota está ativa

### Worker não chama o webhook

- Verifique os logs do Worker no Cloudflare
- Confirme que `VERCEL_WEBHOOK_URL` e `WEBHOOK_SECRET` estão configurados
- Teste o webhook diretamente com curl:

```bash
curl -X POST https://casca-automation-blog.vercel.app/api/webhook/email \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_WEBHOOK_SECRET" \
  -d '{
    "from": "seu@email.com",
    "to": "approve@seudominio.com",
    "subject": "Re: Article",
    "body": "poste",
    "hasApprovalKeyword": true
  }'
```

### Webhook não publica

- Verifique os logs no Vercel
- Confirme que existe um draft com status "sent" no Supabase
- Verifique se as credenciais do Hashnode estão corretas

## Custos

- **Email Routing**: 100% gratuito
- **Email Worker**: 100,000 requisições/dia gratuitas (você usa 1/dia)
- **Custo total**: R$ 0,00

## Próximos Passos

Após configurar, o fluxo automático será:

1. 🌅 **00:00** - Mac Mini roda `npm run daily`
2. 🔍 Descobre artista → Sintetiza artigo → Envia email
3. 📧 Você recebe o email no seu inbox
4. ✍️ Você responde com "poste"
5. ⚡ Cloudflare Worker detecta → Chama Vercel webhook
6. 🚀 Webhook publica no Hashnode
7. ✅ Artigo publicado automaticamente!
