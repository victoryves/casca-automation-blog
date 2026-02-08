# Configuração do Hashnode

Este guia mostra como configurar o Hashnode para publicação automática de artigos do CASCA Archive.

## Passo 1: Criar conta no Hashnode

1. Acesse https://hashnode.com
2. Clique em "Sign up" e crie sua conta
3. Confirme seu email

## Passo 2: Criar sua publicação (blog)

1. No dashboard, clique em "Create Blog"
2. Preencha as informações:
   - **Blog Name**: CASCA Archive (ou nome que preferir)
   - **Blog Handle**: casca-archive (será usado na URL temporária)
   - **Description**: Visual artists from Northeast Brazil
3. Clique em "Create Blog"

## Passo 3: Conectar domínio customizado (opcional mas recomendado)

1. Na sua publicação, vá em **Settings → Domain**
2. Adicione seu domínio (ex: `blog.casca-archive.com` ou `casca-archive.com`)
3. Configure os DNS records conforme instruído:
   - Tipo A: aponte para o IP do Hashnode
   - Ou CNAME: aponte para `hashnode.network`
4. Aguarde propagação DNS (pode levar até 48h, mas geralmente é rápido)

## Passo 4: Obter Publication ID

1. Na sua publicação, vá em **Settings → General**
2. Procure por "Publication ID" ou copie da URL do dashboard
3. Ou você pode encontrar na URL: `https://hashnode.com/[USERNAME]/dashboard?id=[PUBLICATION_ID]`
4. Copie o **PUBLICATION_ID** (será algo como: `6582f9a2b3e4c5d6a7b8c9d0`)

**Método alternativo via API:**

Você pode usar este comando curl para obter seu Publication ID:

```bash
curl -X POST https://gql.hashnode.com \
  -H "Content-Type: application/json" \
  -H "Authorization: SEU_API_KEY_AQUI" \
  -d '{"query":"{ me { publications { id title } } }"}'
```

## Passo 5: Gerar API Key (Personal Access Token)

1. Clique no seu avatar no canto superior direito
2. Vá em **Account Settings → Developer**
3. Ou acesse diretamente: https://hashnode.com/settings/developer
4. Clique em "Generate New Token"
5. Dê um nome descritivo: "CASCA Archive Bot"
6. Selecione as permissões necessárias:
   - ✅ **Write articles**
   - ✅ **Manage publications**
7. Clique em "Generate"
8. **⚠️ IMPORTANTE**: Copie o token IMEDIATAMENTE - ele só será mostrado uma vez!

## Passo 6: Adicionar credenciais no projeto

Abra o arquivo `.env` e adicione:

```env
HASHNODE_API_KEY=seu_token_aqui
HASHNODE_PUBLICATION_ID=seu_publication_id_aqui
```

Exemplo completo:

```env
# Hashnode
HASHNODE_API_KEY=pk_abc123def456ghi789jkl012mno345pqr
HASHNODE_PUBLICATION_ID=6582f9a2b3e4c5d6a7b8c9d0
```

## Passo 7: Testar publicação

Execute o teste de publicação:

```bash
npx tsx scripts/test-publish.ts
```

Se tudo estiver correto, você verá:
```
🚀 Publishing draft to Hashnode...
  ✓ Published to Hashnode: https://casca-archive.hashnode.dev/seu-artigo
  ✓ Publication logged
  ✓ Artist marked as published
```

## Customização adicional (opcional)

### Aparência do blog

1. Vá em **Settings → Appearance**
2. Escolha um tema ou customize cores
3. Adicione logo e favicon
4. Configure layout (sidebar, header, etc)

### SEO

1. Vá em **Settings → SEO**
2. Configure meta description padrão
3. Adicione Google Analytics ID (se tiver)

### Integração de newsletter

1. Vá em **Settings → Newsletter**
2. Ative newsletter para permitir assinantes
3. Configure email de boas-vindas

### Domínio customizado no Medium (se ainda quiser)

O Hashnode permite canonical URLs, então você pode publicar no Hashnode e importar para o Medium depois, mantendo o Hashnode como fonte original.

## Troubleshooting

### Erro: "Invalid API key"
- Verifique se copiou o token completo
- Gere um novo token se necessário
- Certifique-se de que o token tem permissões de "Write articles"

### Erro: "Publication not found"
- Verifique se o PUBLICATION_ID está correto
- Use a query GraphQL acima para listar suas publicações

### Artigo não aparece no blog
- Verifique se o status foi "public" (não "draft")
- Aguarde alguns segundos - pode haver delay
- Verifique em Settings → Posts se o artigo foi criado

### Domínio customizado não funciona
- Aguarde propagação DNS (até 48h)
- Verifique se os DNS records estão corretos
- Use https://dnschecker.org para verificar propagação

## Recursos

- 📚 Documentação oficial da API: https://apidocs.hashnode.com
- 🎨 GraphQL Playground: https://gql.hashnode.com
- 💬 Suporte: https://support.hashnode.com
- 👥 Comunidade: https://hashnode.com/forum

## Próximos passos

Agora que o Hashnode está configurado, você pode:

1. Responder emails de aprovação com "poste" para publicar automaticamente
2. Customizar a aparência do seu blog
3. Conectar seu domínio customizado
4. Compartilhar seus artigos nas redes sociais

O sistema está pronto para publicar automaticamente no Hashnode quando você aprovar os artigos! 🎉
