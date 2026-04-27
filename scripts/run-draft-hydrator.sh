#!/bin/bash

# CASCA Editorial Agent - Continuous Draft Hydrator
# Converts reliable artists into fully-ready drafts and sends the daily approval email at 5am.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || { echo "FATAL: Cannot cd to $PROJECT_DIR"; exit 1; }

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export APP_TIMEZONE="${APP_TIMEZONE:-America/Toronto}"
export HYDRATOR_IDLE_SECONDS="${HYDRATOR_IDLE_SECONDS:-60}"
export HYDRATOR_ERROR_SECONDS="${HYDRATOR_ERROR_SECONDS:-90}"
export HYDRATOR_MIN_READY_DRAFTS="${HYDRATOR_MIN_READY_DRAFTS:-3}"

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

LOG_FILE="$PROJECT_DIR/logs/miners/draft-hydrator.log"
STATUS_FILE="$PROJECT_DIR/logs/runtime/draft-hydrator-status.json"
LOCK_FILE="$PROJECT_DIR/logs/miners/draft-hydrator.lock"

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
  "worker": "draft-hydrator",
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
    log "Another draft hydrator is already running (pid $EXISTING_PID). Exiting."
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
log "CASCA Draft Hydrator - 24/7 Loop"
log "Node: $(node --version) | npm: $(npm --version)"
log "Timezone: $APP_TIMEZONE"
log "========================================"

write_status "booting" "Starting continuous draft hydration loop" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"

ready_pending_count() {
  local db_path="$PROJECT_DIR/data/casca.sqlite"
  if [ ! -f "$db_path" ] || ! command -v sqlite3 >/dev/null 2>&1; then
    echo 0
    return
  fi

  sqlite3 "$db_path" "select count(*) from drafts where status='pending' and images is not null and images <> '';" 2>/dev/null || echo 0
}

run_workflow_pass() {
  local label="$1"
  shift

  write_status "$label" "Running workflow pass: $label" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"
  log "Workflow pass: $label"
  npm run daily -- --wait-for-lock "$@" >> "$LOG_FILE" 2>&1
  return $?
}

while true; do
  READY_COUNT="$(ready_pending_count)"
  write_status "send-check" "Primary pass with ready backlog count=${READY_COUNT}" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"

  run_workflow_pass "send-check"
  PRIMARY_EXIT=$?
  LAST_EXIT=$PRIMARY_EXIT

  if [ $PRIMARY_EXIT -eq 0 ]; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  else
    FAILURE_COUNT=$((FAILURE_COUNT + 1))
  fi

  READY_COUNT="$(ready_pending_count)"
  NEED_WATCHDOG=0
  if [ "$READY_COUNT" -lt "$HYDRATOR_MIN_READY_DRAFTS" ]; then
    NEED_WATCHDOG=1
    log "Ready backlog below floor (${READY_COUNT}/${HYDRATOR_MIN_READY_DRAFTS}). Escalating recovery."
  fi
  if [ $PRIMARY_EXIT -eq 2 ]; then
    NEED_WATCHDOG=1
    log "Primary pass exited with code 2. Escalating recovery."
  fi

  if [ $NEED_WATCHDOG -eq 1 ]; then
    run_workflow_pass "watchdog-send" --force
    WATCHDOG_SEND_EXIT=$?
    LAST_EXIT=$WATCHDOG_SEND_EXIT
    if [ $WATCHDOG_SEND_EXIT -eq 0 ]; then
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
    fi

    run_workflow_pass "watchdog-prepare" --prepare-only
    WATCHDOG_PREP_EXIT=$?
    LAST_EXIT=$WATCHDOG_PREP_EXIT
    if [ $WATCHDOG_PREP_EXIT -eq 0 ]; then
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
    fi
  else
    run_workflow_pass "hydrate-backlog" --prepare-only
    PREP_EXIT=$?
    LAST_EXIT=$PREP_EXIT
    if [ $PREP_EXIT -eq 0 ]; then
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
    fi
  fi

  READY_COUNT="$(ready_pending_count)"
  if [ "$READY_COUNT" -lt "$HYDRATOR_MIN_READY_DRAFTS" ]; then
    write_status "low-backlog" "Ready backlog still low (${READY_COUNT}/${HYDRATOR_MIN_READY_DRAFTS}); retrying in ${HYDRATOR_ERROR_SECONDS}s" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"
    log "Ready backlog still low (${READY_COUNT}/${HYDRATOR_MIN_READY_DRAFTS}). Retrying in ${HYDRATOR_ERROR_SECONDS}s."
    sleep "$HYDRATOR_ERROR_SECONDS"
    continue
  fi

  write_status "idle" "Hydrator loop complete with ready backlog ${READY_COUNT}; sleeping ${HYDRATOR_IDLE_SECONDS}s" "$SUCCESS_COUNT" "$FAILURE_COUNT" "$LAST_EXIT"
  log "Hydrator loop complete with ready backlog ${READY_COUNT}. Sleeping ${HYDRATOR_IDLE_SECONDS}s."
  sleep "$HYDRATOR_IDLE_SECONDS"
done
