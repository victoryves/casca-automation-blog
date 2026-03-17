#!/bin/bash

# CASCA Editorial Agent - Daily Execution Wrapper (Bulletproof)
# Runs the full workflow: discover → verify → synthesize → email
# Never fails silently. Logs everything. Retries on transient errors.

PROJECT_DIR="/Users/victoryves/Documents/personal/Vibe Coding/casca-automation-blog"
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

# Create logs directory
mkdir -p "$PROJECT_DIR/logs/daily"

LOG_FILE="$PROJECT_DIR/logs/daily/$(date +%Y-%m-%d).log"

log() {
  echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "========================================"
log "CASCA Editorial Agent - Daily Run"
log "Node: $(node --version) | npm: $(npm --version)"
log "========================================"

# Retry logic: try up to 3 times with 60s between attempts
MAX_RETRIES=3
RETRY_DELAY=60

for attempt in $(seq 1 $MAX_RETRIES); do
  log "Attempt $attempt/$MAX_RETRIES"

  npm run daily >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    log "SUCCESS (attempt $attempt)"
    exit 0
  fi

  log "FAILED with exit code $EXIT_CODE"

  if [ $attempt -lt $MAX_RETRIES ]; then
    log "Retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
  fi
done

log "ALL $MAX_RETRIES ATTEMPTS FAILED"

# Send failure notification via curl to a simple webhook (optional, won't break if fails)
# This ensures you know when the cron fails even if you don't check logs
curl -s -X POST "https://casca-automation-blog.vercel.app/api/webhook/approve?draft=0&token=FAILURE_NOTIFICATION" \
  > /dev/null 2>&1 || true

exit 1
