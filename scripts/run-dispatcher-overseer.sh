#!/bin/bash

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || { echo "FATAL: Cannot cd to $PROJECT_DIR"; exit 1; }

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export APP_TIMEZONE="${APP_TIMEZONE:-America/Toronto}"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  . "$PROJECT_DIR/.env"
  set +a
fi

if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  . "$PROJECT_DIR/.env.local"
  set +a
fi

mkdir -p "$PROJECT_DIR/logs/daily"
LOG_FILE="$PROJECT_DIR/logs/daily/dispatcher-overseer-$(date '+%Y-%m-%d').log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Dispatcher pass" >> "$LOG_FILE"
npm run dispatcher >> "$LOG_FILE" 2>&1 || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Overseer pass" >> "$LOG_FILE"
npm run overseer >> "$LOG_FILE" 2>&1 || true
