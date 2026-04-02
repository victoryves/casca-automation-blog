#!/bin/bash

# CASCA Editorial Agent - Webhook Server Wrapper (Watchdog)
# Keeps the local webhook server alive and auto-restarts on failure.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || { echo "FATAL: Cannot cd to $PROJECT_DIR"; exit 1; }

# Setup PATH for homebrew + node
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production

# Load nvm if available (don't fail if it doesn't exist)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null

# Verify node/npm exist
if ! command -v node &>/dev/null; then
  echo "FATAL: node not found in PATH=$PATH"
  exit 1
fi
if ! command -v npm &>/dev/null; then
  echo "FATAL: npm not found in PATH=$PATH"
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs"
LOG_FILE="$PROJECT_DIR/logs/webhooks-watchdog.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "Webhook watchdog starting"

while true; do
  log "Launching webhook server"
  npm run webhooks >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  log "Webhook server exited with code $EXIT_CODE; restarting in 2s"
  sleep 2
done
