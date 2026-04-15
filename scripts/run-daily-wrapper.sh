#!/bin/bash

# CASCA Editorial Agent - Daily Execution Wrapper (Bulletproof)
# Runs the full workflow: discover → verify → synthesize → email
# Never fails silently. Logs everything. Retries on transient errors.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || { echo "FATAL: Cannot cd to $PROJECT_DIR"; exit 1; }

# Setup PATH for homebrew + node
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export APP_TIMEZONE="${APP_TIMEZONE:-America/Toronto}"

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
LOCK_FILE="$PROJECT_DIR/logs/daily/run.lock"

log() {
  echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

if [ -f "$LOCK_FILE" ]; then
  EXISTING_PID="$(cat "$LOCK_FILE" 2>/dev/null)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "Another run is already in progress (pid $EXISTING_PID). Exiting."
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

log "========================================"
log "CASCA Editorial Agent - Continuous Run"
log "Node: $(node --version) | npm: $(npm --version)"
log "Timezone: $APP_TIMEZONE"
log "========================================"

# Persistent retry logic:
# 1. Run the normal workflow to send the daily approval email when needed.
# 2. Immediately run a prepare-only pass to keep mining the internet and fill the backlog.
ATTEMPT=0
RETRY_DELAY=60
LONG_RETRY_DELAY=300

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  log "Attempt $ATTEMPT - normal send workflow"

  npm run daily >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    log "Normal workflow completed (attempt $ATTEMPT)"
    log "Attempt $ATTEMPT - prepare-only backlog replenishment"
    npm run daily -- --prepare-only >> "$LOG_FILE" 2>&1
    PREP_EXIT_CODE=$?

    if [ $PREP_EXIT_CODE -eq 0 ]; then
      log "Backlog replenishment completed (attempt $ATTEMPT)"
      exit 0
    fi

    if [ $PREP_EXIT_CODE -eq 2 ]; then
      log "Backlog replenishment found no approval-ready artist yet. Continuing in ${RETRY_DELAY}s..."
      sleep $RETRY_DELAY
      continue
    fi

    log "Prepare-only workflow errored. Retrying in ${LONG_RETRY_DELAY}s..."
    sleep $LONG_RETRY_DELAY
    continue
  fi

  log "FAILED with exit code $EXIT_CODE"

  if [ $EXIT_CODE -eq 2 ]; then
    log "Workflow found no approval-ready artist yet. Continuing search in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
    continue
  fi

  log "Transient or fatal workflow error. Retrying in ${LONG_RETRY_DELAY}s..."
  sleep $LONG_RETRY_DELAY
done
