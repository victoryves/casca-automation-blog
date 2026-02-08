# CASCA Editorial Agent - Mac Mini Setup Instructions

Este documento contém todas as instruções para configurar o CASCA Editorial Agent no Mac Mini via OpenClaw CLI Agent.

## Setup Completo (Copie e cole todos os comandos abaixo)

```bash
# 1. Definir diretório do projeto
PROJECT_DIR="$HOME/casca-automation-blog"

# 2. Clonar ou atualizar o repositório
if [ -d "$PROJECT_DIR" ]; then
  echo "📦 Atualizando repositório..."
  cd "$PROJECT_DIR"
  git pull origin main
else
  echo "📦 Clonando repositório..."
  git clone https://github.com/victoryves/casca-automation-blog.git "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

# 3. Instalar dependências
echo "📚 Instalando dependências..."
npm install

# 4. Criar arquivo .env com as credenciais
echo "🔐 Criando arquivo .env..."
cat > "$PROJECT_DIR/.env" << 'ENVEOF'
# Database (Supabase)
SUPABASE_URL=https://xmtwoullpdvytamtbafz.supabase.co
SUPABASE_KEY=sb_publishable_HPqEjuvcCsQag9q7Zx3nZg_IZgFBG-V

# APIs
ANTHROPIC_API_KEY=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
RESEND_API_KEY=re_6cui3wgF_KNZy7GsmePhY5ZEqhcKca8Sj
TAVILY_API_KEY=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

# Email
APPROVAL_EMAIL=victoryves@gmail.com
FROM_EMAIL=onboarding@resend.dev

# Publishing
AUTHOR_NAME=Victor Yves

# Hashnode
HASHNODE_API_KEY=dfb2eebe-5524-403c-84a3-5ae5463fde75
HASHNODE_PUBLICATION_ID=6988864547396a0a8bf533a2

# Deployment
WEBHOOK_SECRET=f9c7a2d4b1e84e6fb0a9c3d7e5a1c8f2-9a4e6b7d2c0f1e8a5b3d7c9e4f6

# Logging
LOG_LEVEL=info
ENVEOF

# 5. Criar diretórios de logs
echo "📁 Criando diretórios de logs..."
mkdir -p "$PROJECT_DIR/logs/daily"

# 6. Garantir que os scripts são executáveis
echo "🔧 Configurando permissões..."
chmod +x "$PROJECT_DIR/scripts"/*.sh

# 7. Atualizar o wrapper script com o caminho correto
echo "📝 Configurando wrapper script..."
sed -i '' "s|PROJECT_DIR=\".*\"|PROJECT_DIR=\"$PROJECT_DIR\"|g" "$PROJECT_DIR/scripts/run-daily-wrapper.sh"

# 8. Atualizar o plist com o caminho correto do usuário
echo "📝 Configurando launchd plist..."
USER_HOME="$HOME"
sed -i '' "s|/Users/vicyves1|$USER_HOME|g" "$PROJECT_DIR/com.casca.daily-workflow.plist"

# 9. Instalar o agendamento
echo "⏰ Instalando agendamento diário (meia-noite)..."
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/com.casca.daily-workflow.plist"

mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload se já existir
if [ -f "$INSTALLED_PLIST" ]; then
  launchctl unload "$INSTALLED_PLIST" 2>/dev/null || true
fi

# Copiar e carregar
cp "$PROJECT_DIR/com.casca.daily-workflow.plist" "$INSTALLED_PLIST"
chmod 644 "$INSTALLED_PLIST"
launchctl load "$INSTALLED_PLIST"

# 10. Testar a instalação
echo ""
echo "✅ Setup completo!"
echo ""
echo "🧪 Testando configuração..."
cd "$PROJECT_DIR"
npm run daily -- --dry-run

echo ""
echo "📊 Status do agendamento:"
launchctl list | grep casca || echo "⚠️  Agente não encontrado"

echo ""
echo "✅ CASCA Editorial Agent instalado com sucesso!"
echo ""
echo "📅 O script rodará diariamente à meia-noite (00:00)"
echo ""
echo "📋 Comandos úteis:"
echo "  Ver logs: tail -f $PROJECT_DIR/logs/daily/\$(date +%Y-%m-%d).log"
echo "  Testar: cd $PROJECT_DIR && npm run daily -- --dry-run"
echo "  Status: launchctl list | grep casca"
echo ""
```

## Verificação Pós-Instalação

Após executar o setup acima, rode estes comandos para verificar:

```bash
# Verificar se o agente está rodando
launchctl list | grep casca

# Testar execução manual (modo dry-run, não envia email)
cd ~/casca-automation-blog
npm run daily -- --dry-run

# Ver última linha do log
tail -1 ~/casca-automation-blog/logs/daily/$(date +%Y-%m-%d).log
```

## Configurações Importantes do Mac Mini

Para garantir que o script rode à meia-noite, configure:

1. **Prevenir o Mac de dormir:**
   ```bash
   sudo pmset -a sleep 0
   sudo pmset -a displaysleep 10
   sudo pmset -a disksleep 0
   ```

2. **OU acordar para tarefas (recomendado):**
   ```bash
   sudo pmset -a womp 1
   sudo pmset -a powernap 1
   ```

## Desinstalar (se necessário)

```bash
cd ~/casca-automation-blog
./scripts/uninstall-cron.sh
```

## Troubleshooting

### Se o teste falhar

1. Verificar se Node.js está instalado:
   ```bash
   node --version
   npm --version
   ```

2. Verificar se o .env foi criado corretamente:
   ```bash
   cat ~/casca-automation-blog/.env | head -5
   ```

3. Verificar logs de erro:
   ```bash
   cat ~/casca-automation-blog/logs/launchd-stderr.log
   ```

### Se o agente não aparecer no launchctl list

```bash
# Recarregar manualmente
launchctl load ~/Library/LaunchAgents/com.casca.daily-workflow.plist

# Verificar se o arquivo está lá
ls -la ~/Library/LaunchAgents/com.casca.daily-workflow.plist
```

## Atualizar no Futuro

Quando houver mudanças no código:

```bash
cd ~/casca-automation-blog
git pull origin main
npm install
# O cron continuará funcionando automaticamente
```
