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
echo "⚠️  IMPORTANTE: Você precisa adicionar suas credenciais reais no .env"
echo "Crie manualmente o arquivo .env com suas próprias keys:"
echo ""
echo "cat > \$PROJECT_DIR/.env << 'ENVEOF'"
echo "# Database (Supabase)"
echo "SUPABASE_URL=your-supabase-url"
echo "SUPABASE_KEY=your-supabase-key"
echo ""
echo "# APIs"
echo "ANTHROPIC_API_KEY=sk-ant-xxxxx"
echo "RESEND_API_KEY=re_xxxxx"
echo "TAVILY_API_KEY=tvly-xxxxx"
echo ""
echo "# Email"
echo "APPROVAL_EMAIL=your@email.com"
echo "FROM_EMAIL=noreply@yourdomain.com"
echo ""
echo "# Publishing"
echo "AUTHOR_NAME=Your Name"
echo ""
echo "# Hashnode"
echo "HASHNODE_API_KEY=your-hashnode-key"
echo "HASHNODE_PUBLICATION_ID=your-publication-id"
echo ""
echo "# Deployment"
echo "WEBHOOK_SECRET=your-webhook-secret"
echo ""
echo "# Logging"
echo "LOG_LEVEL=info"
echo "ENVEOF"
echo ""
echo "⚠️  NUNCA commite o arquivo .env no Git!"

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
