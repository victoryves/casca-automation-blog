#!/bin/bash

# CASCA Editorial Agent - Continuous Research Miner
# Keeps the shortlist / reliable-artist cache growing 24/7.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || { echo "FATAL: Cannot cd to $PROJECT_DIR"; exit 1; }

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export APP_TIMEZONE="${APP_TIMEZONE:-America/Toronto}"
export PREMINE_BATCH_SIZE="${PREMINE_BATCH_SIZE:-20}"
export RESEARCH_MINER_SLEEP_SECONDS="${RESEARCH_MINER_SLEEP_SECONDS:-180}"
export RESEARCH_MINER_ERROR_SLEEP_SECONDS="${RESEARCH_MINER_ERROR_SLEEP_SECONDS:-420}"

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

if ! command -v node &>/dev/null; then
  echo "FATAL: node not found in PATH=$PATH"
  exit 1
fi
if ! command -v npm &>/dev/null; then
  echo "FATAL: npm not found in PATH=$PATH"
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs/miners" "$PROJECT_DIR/logs/runtime"

LOG_FILE="$PROJECT_DIR/logs/miners/research-miner.log"
STATUS_FILE="$PROJECT_DIR/logs/runtime/research-miner-status.json"
LOCK_FILE="$PROJECT_DIR/logs/miners/research-miner.lock"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

write_status() {
  local phase="$1"
  local detail="$2"
  local success_count="$3"
  local failure_count="$4"
  local last_exit="$5"

  cat > "$STATUS_FILE" <<EOF
{
  "worker": "research-miner",
  "pid": $$,
  "phase": "$(printf '%s' "$phase" | sed 's/"/\\"/g')",
  "detail": "$(printf '%s' "$detail" | sed 's/"/\\"/g')",
  "updatedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "timezone": "${APP_TIMEZONE}",
  "successCount": ${success_count},
  "failureCount": ${failure_count},
  "lastExitCode": ${last_exit}
}
EOF
}

if [ -f "$LOCK_FILE" ]; then
  EXISTING_PID="$(cat "$LOCK_FILE" 2>/dev/null)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "Another research miner is already running (pid $EXISTING_PID). Exiting."
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

SUCCESS_COUNT=0
FAILURE_COUNT=0
LAST_EXIT=0

log "========================================"
log "CASCA Research Miner - 24/7 Loop"
log "Node: $(node --version) | npm: $(npm --version)"
log "Timezone: $APP_TIMEZONE | Batch: $PREMINE_BATCH_SIZE"
log "========================================"

write_status "booting" "Starting continuous shortlist mining loop" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"

while true; do
  write_status "mining" "Running pre-mine-shortlist batch ${PREMINE_BATCH_SIZE}" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"
  log "Running pre-mine-shortlist (batch ${PREMINE_BATCH_SIZE})"

  npm run pre-mine-shortlist -- --limit "${PREMINE_BATCH_SIZE}" >> "$LOG_FILE" 2>&1
  LAST_EXIT=$?

  if [ $LAST_EXIT -eq 0 ]; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    write_status "idle" "Last mining pass completed successfully; sleeping ${RESEARCH_MINER_SLEEP_SECONDS}s" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"
    log "Pre-mining pass completed successfully. Sleeping ${RESEARCH_MINER_SLEEP_SECONDS}s."
    sleep "$RESEARCH_MINER_SLEEP_SECONDS"
    continue
  fi

  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  write_status "error" "Mining pass failed with exit ${LAST_EXIT}; retrying in ${RESEARCH_MINER_ERROR_SLEEP_SECONDS}s" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"
  log "Pre-mining pass failed with exit ${LAST_EXIT}. Retrying in ${RESEARCH_MINER_ERROR_SLEEP_SECONDS}s."
  sleep "$RESEARCH_MINER_ERROR_SLEEP_SECONDS"
done
