# OpenClaw Agent Guide - CASCA Editorial System

## 🤖 O que este sistema faz

Este é um sistema automatizado de descoberta e publicação de artigos sobre artistas visuais do Nordeste do Brasil. Ele roda **diariamente às 00:00** no Mac Mini via cron job.

## 📅 Execução Diária Automática

### O que acontece todo dia à meia-noite:

1. **🔍 Descoberta de Artista** (se não houver artista verificado)
   - Busca até 5 candidatos via Tavily API
   - Filtra por: artista visual + Nordeste do Brasil
   - Valida fontes institucionais confiáveis
   - **Para quando encontra pelo menos 1 artista verificado**

2. **✅ Verificação**
   - Confirma elegibilidade (visual artist + Northeast Brazil)
   - Cross-valida com múltiplas fontes
   - Marca como "verified" no banco

3. **✍️ Síntese do Artigo**
   - Gera artigo em inglês usando Claude AI
   - Estilo Medium-quality
   - ~800-1000 palavras
   - Inclui título, subtítulo, keywords

4. **🖼️ Busca de Imagens** (SEMPRE com imagens)
   - Busca 3 imagens do artista
   - Fontes: Wikimedia Commons → Bing → DuckDuckGo → Google
   - **VALIDAÇÃO**: Se não encontrar pelo menos 1 imagem, o workflow PARA
   - Gera atribuições corretas

5. **📧 Envio de Email**
   - Email formatado com artigo completo
   - Imagens embutidas como anexos
   - **Inclui comando pronto para OpenClaw Agent**
   - Enviado para: victoryves@gmail.com

## 📧 Quando você recebe o email

O email de aprovação contém:

### **Comando OpenClaw (Copiar e Colar):**
```bash
cd /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog && npm run publish
```

### **O que esse comando faz:**
1. Marca o draft como "approved"
2. Publica no Hashnode via GraphQL API
3. Atualiza status do artista para "published"
4. Loga a publicação no Supabase

## 🚀 Comandos Importantes

### Publicar artigo manualmente
```bash
cd /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog && npm run publish
```

### Rodar workflow diário manualmente (teste)
```bash
cd /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog && npm run daily
```

### Ver logs de execução
```bash
tail -f /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog/logs/daily/$(date +%Y-%m-%d).log
```

### Verificar status do cron
```bash
launchctl list | grep casca
```

## 🔄 Fluxo Completo

```
00:00 - Mac Mini cron inicia
  ↓
🔍 Discovery busca artista (até encontrar 1 verificado)
  ↓
✅ Verificação confirma elegibilidade
  ↓
✍️ Claude gera artigo
  ↓
🖼️ Busca 3 imagens (OBRIGATÓRIO: pelo menos 1)
  ↓
📧 Email enviado com artigo + comando
  ↓
👤 Victor recebe email
  ↓
🤖 Victor copia comando e envia para OpenClaw
  ↓
⚡ OpenClaw executa: npm run publish
  ↓
🚀 Artigo publicado no Hashnode
  ↓
✅ Sistema marca como publicado
  ↓
💤 Sistema aguarda próximo dia (00:00)
```

## 📊 Garantias do Sistema

### ✅ O que é GARANTIDO:

1. **Um artista por dia** - O sistema só procura se não há artista verificado
2. **Sempre com imagens** - Se não encontrar imagens, não envia email
3. **Apenas um email por dia** - Check automático previne duplicação
4. **Auto-atualização** - Git pull antes de cada execução
5. **Aprovação manual** - Nada publica sem seu comando

### ❌ O que NÃO faz:

1. **Publicar automaticamente** - Sempre requer seu comando via OpenClaw
2. **Enviar múltiplos emails** - Máximo 1 por dia
3. **Processar sem imagens** - Workflow para se não encontrar imagens

## 🛠️ Troubleshooting

### Email não chegou?
```bash
# Verificar se workflow rodou
tail -100 /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog/logs/wrapper-$(date +%Y-%m-%d).log

# Rodar manualmente
cd /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog && npm run daily
```

### Publicação falhou?
```bash
# Verificar logs de erro
tail -100 /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog/logs/daily/$(date +%Y-%m-%d).log

# Tentar publicar novamente
npm run publish
```

### Cron não está rodando?
```bash
# Verificar se está carregado
launchctl list | grep casca

# Recarregar se necessário
launchctl unload ~/Library/LaunchAgents/com.casca.daily-workflow.plist
launchctl load ~/Library/LaunchAgents/com.casca.daily-workflow.plist
```

## 🔧 Arquivos Importantes

- **Workflow principal**: `src/orchestrator/workflow.ts`
- **Script diário**: `scripts/run-daily.ts`
- **Script de publicação**: `scripts/publish-draft.ts`
- **Wrapper do cron**: `scripts/run-daily-wrapper.sh`
- **Configuração launchd**: `~/Library/LaunchAgents/com.casca.daily-workflow.plist`
- **Logs**: `logs/wrapper-YYYY-MM-DD.log`

## 📈 Estatísticas

- **Frequência**: 1x por dia às 00:00
- **Email limite**: 1 por dia (proteção anti-spam)
- **Candidatos por busca**: Até 5 (para garantir 1 verificado)
- **Imagens por artigo**: 3 (mínimo: 1)
- **Custo**: R$ 0,00 (todos serviços gratuitos)

## 🎯 Workflow Típico (para OpenClaw Agent)

Quando Victor pede para publicar um artigo:

```
Victor: [cola o comando do email]
OpenClaw executa:
  cd /Users/vicyves1/Documents/personal/Vibe\ Coding/casca-automation-blog && npm run publish

OpenClaw responde com:
  - Status da publicação
  - URL do artigo no Hashnode
  - Confirmação de sucesso
```

## 🔐 Variáveis de Ambiente

Todas configuradas em `.env`:
- `SUPABASE_URL` - Banco de dados PostgreSQL
- `SUPABASE_KEY` - Chave de acesso
- `ANTHROPIC_API_KEY` - Claude AI para geração de artigos
- `RESEND_API_KEY` - Envio de emails transacionais
- `TAVILY_API_KEY` - Busca de artistas
- `HASHNODE_API_KEY` - Publicação de artigos
- `HASHNODE_PUBLICATION_ID` - Blog CASCA Archive
- `APPROVAL_EMAIL` - victoryves@gmail.com
- `FROM_EMAIL` - noreply@casca-archive.org

## 📞 Suporte

Para problemas ou dúvidas:
1. Verificar logs em `logs/`
2. Consultar este guia (OPENCLAW-GUIDE.md)
3. Consultar MACMINI-SETUP.md para configuração do cron
4. Consultar CLOUDFLARE-SETUP.md para email webhook (futuro)

---

**Última atualização**: 2026-02-08
**Sistema**: CASCA Editorial Agent v1.0
**Maintainer**: Victor Yves (OpenClaw Agent assisted)
