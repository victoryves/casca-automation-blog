#!/bin/bash

# CASCA Editorial Agent - Minute Guard
# Runs a short primary pass every minute:
# 1. If there is no active approval draft and nothing approved, send a new article.
# 2. Always run a prepare-only replenishment pass to keep the backlog growing.

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
LOG_FILE="$PROJECT_DIR/logs/daily/minute-guard-$(date '+%Y-%m-%d').log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Minute guard primary pass" >> "$LOG_FILE"
npm run daily -- --wait-for-lock >> "$LOG_FILE" 2>&1 || \
  npm run daily -- --wait-for-lock --cache-only --skip-discovery >> "$LOG_FILE" 2>&1 || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Minute guard prepare-only pass" >> "$LOG_FILE"
npm run daily -- --wait-for-lock --prepare-only >> "$LOG_FILE" 2>&1 || \
  npm run daily -- --wait-for-lock --prepare-only --cache-only >> "$LOG_FILE" 2>&1 || true
