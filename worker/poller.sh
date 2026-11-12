#!/usr/bin/env bash
# Poll MinoCode hub for queued stress jobs and run k6 checkout.js
# Env: HUB_URL, WORKER_SECRET, K6_BIN=k6, POLL_INTERVAL=5, MAX_RUNTIME_SECONDS (0 = forever)
set -uo pipefail

HUB_URL="${HUB_URL:?HUB_URL required}"
WORKER_SECRET="${WORKER_SECRET:?WORKER_SECRET required}"
K6_BIN="${K6_BIN:-k6}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
MAX_RUNTIME_SECONDS="${MAX_RUNTIME_SECONDS:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${WORKDIR:-/tmp/awc-stress-worker}"
mkdir -p "$WORKDIR"
START=$(date +%s)

echo "[awc-stress-worker] polling ${HUB_URL%/}/portal/stress/jobs/next (max ${MAX_RUNTIME_SECONDS}s)"

while true; do
  if [[ "$MAX_RUNTIME_SECONDS" -gt 0 ]] && (( $(date +%s) - START >= MAX_RUNTIME_SECONDS )); then
    echo "[awc-stress-worker] runtime limit reached, exiting cleanly"
    exit 0
  fi
  RESP="$(curl -fsS --max-time 20 -H "X-AWC-Worker-Secret: ${WORKER_SECRET}" \
    "${HUB_URL%/}/portal/stress/jobs/next" 2>/dev/null || true)"
  JOB="$(printf '%s' "$RESP" | jq -c 'if (.job // null) then .job else empty end' 2>/dev/null || true)"
  if [[ -z "$JOB" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi
  RUN_ID="$(printf '%s' "$JOB" | jq -r '(.run_id // 0) | tonumber? // 0')"
  JOB_FILE="${WORKDIR}/run-${RUN_ID}.json"
  printf '%s' "$JOB" > "$JOB_FILE"
  echo "[awc-stress-worker] claimed run ${RUN_ID}"
  ( cd "$WORKDIR" && AWC_STRESS_JOB_FILE="$JOB_FILE" "$K6_BIN" run "${SCRIPT_DIR}/checkout.js" ) || true
  # job file and summary.json contain the checkout token / worker secret; never keep or upload them
  rm -f "$JOB_FILE" "${WORKDIR}/summary.json"
  echo "[awc-stress-worker] finished run ${RUN_ID}"
  sleep 2
done
