#!/usr/bin/env bash
# Transcript Dock API: cURL examples.
#
# Usage:
#   export TRANSCRIPTDOCK_API_KEY="td_live_..."
#   bash examples.sh help
#
# Each command below is one API call (or a short chain). Commands that create
# jobs spend real credits; the cost is written next to each one. Nothing runs
# unless you name a command.
#
# Needs: bash, curl. The "wait" and "batch-status" commands also need jq.

set -euo pipefail

API="https://www.transcriptdock.com" # always www: the apex domain redirects

# A fresh idempotency key. Set IDEMPOTENCY_KEY yourself to replay a request
# whose response you lost: same key and same body returns the original job.
new_key() {
  if [ -n "${IDEMPOTENCY_KEY:-}" ]; then
    printf '%s' "$IDEMPOTENCY_KEY"
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    printf 'td-%s-%s%s' "$(date +%s)" "$RANDOM" "$RANDOM"
  fi
}

need_key() {
  : "${TRANSCRIPTDOCK_API_KEY:?Set TRANSCRIPTDOCK_API_KEY to your td_live_ key}"
}

# Refuse values that would break the hand written JSON bodies below.
safe() {
  case "$1" in
    *'"'* | *'\'* ) echo "Refusing a value with quotes or backslashes: $1" >&2; exit 2 ;;
  esac
  printf '%s' "$1"
}

# GET with the API key. --fail-with-body prints the error envelope on 4xx/5xx.
get() {
  need_key
  curl -sS --fail-with-body \
    -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY" \
    "$API$1"
}

# POST JSON with the API key and an idempotency key (printed to stderr so you can save it).
post() {
  need_key
  local key
  key="$(new_key)"
  echo "Idempotency-Key: $key" >&2
  curl -sS --fail-with-body -X POST \
    -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY" \
    -H "Idempotency-Key: $key" \
    -H "Content-Type: application/json" \
    -d "$2" \
    "$API$1"
}

# Accept only a positive whole number (used for max_credits and limits).
num() {
  case "$1" in
    '' | *[!0-9]* | 0) echo "Expected a positive whole number, got: $1" >&2; exit 2 ;;
  esac
  printf '%s' "$1"
}

need_jq() {
  command -v jq >/dev/null 2>&1 || { echo "This command needs jq." >&2; exit 2; }
}

usage() {
  cat <<'EOF'
Commands (cost in brackets):

  capabilities                 What the API supports. No key needed. [free]
  usage                        Your plan and credit balance. [free]
  captions URL                 Captions of a YouTube or TikTok video. [1 credit, 0 if none]
  auto URL [MAX_CREDITS]       Captions, else AI transcription. Paid plans. Default cap 20 (10 minutes). [<= MAX_CREDITS]
  transcribe URL [MAX_CREDITS] AI transcription of any supported link. Paid plans. Default cap 20. [<= MAX_CREDITS]
  job JOB_ID                   Read a job once. [free]
  wait JOB_ID                  Long poll until the job is final (needs jq). [free]
  transcript RESULT_ID         The transcript as JSON. [free]
  export RESULT_ID FORMAT      txt, json, srt or vtt. [free]
  batch URL [URL...]           Captions for several links in one request. [1 per item with captions]
  batch-status BATCH_ID        Batch counters and items (needs jq). [free]
  upload FILE TYPE [MAX]       Upload a local file (e.g. audio/mpeg) and transcribe it. Paid plans. [<= MAX, default 20]
  jobs                         Your last 10 jobs. [free]
  cancel JOB_ID                Cancel before AI transcription starts. [free]
  retry JOB_ID [MAX_CREDITS]   New job from a retryable failure. [as a new job]
EOF
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  capabilities)
    # Public without a key. With a key it answers for your plan.
    if [ -n "${TRANSCRIPTDOCK_API_KEY:-}" ]; then get "/v1/capabilities"; else curl -sS --fail-with-body "$API/v1/capabilities"; fi
    ;;

  usage)
    get "/v1/usage"
    ;;

  captions)
    # captions_only never starts AI transcription. max_credits is ignored for it,
    # but we send it so a later switch to auto keeps a cap.
    url="$(safe "${1:?URL required}")"
    post "/v1/jobs" "{\"source\":{\"url\":\"$url\"},\"mode\":\"captions_only\",\"max_credits\":1}"
    ;;

  auto | transcribe)
    # AI transcription costs 2 credits per started minute, 60 second minimum.
    # The media is measured first; above the cap the job fails with BUDGET_EXCEEDED
    # and nothing is charged.
    url="$(safe "${1:?URL required}")"
    max="$(num "${2:-20}")"
    post "/v1/jobs" "{\"source\":{\"url\":\"$url\"},\"mode\":\"$cmd\",\"max_credits\":$max}"
    ;;

  job)
    get "/v1/jobs/${1:?JOB_ID required}"
    ;;

  wait)
    need_jq
    id="${1:?JOB_ID required}"
    deadline=$(( $(date +%s) + ${TIMEOUT_SECONDS:-600} ))
    while :; do
      body="$(get "/v1/jobs/$id?wait=25")"
      status="$(printf '%s' "$body" | jq -r .status)"
      echo "status: $status" >&2
      case "$status" in
        succeeded | failed | cancelled) printf '%s\n' "$body"; break ;;
      esac
      if [ "$(date +%s)" -ge "$deadline" ]; then echo "Still running. Run wait again later." >&2; exit 1; fi
      sleep 1
    done
    ;;

  transcript)
    get "/v1/transcripts/${1:?RESULT_ID required}"
    ;;

  export)
    get "/v1/transcripts/${1:?RESULT_ID required}/export?format=${2:-txt}"
    ;;

  batch)
    # Every item is a normal job; the whole batch is accepted or rejected together.
    # Items per batch: 1 on the free plan, 10 Starter, 25 Pro, 50 Scale.
    [ "$#" -ge 1 ] || { echo "batch needs at least one URL" >&2; exit 2; }
    items=""
    for u in "$@"; do
      u="$(safe "$u")"
      items="$items{\"source\":{\"url\":\"$u\"},\"mode\":\"captions_only\",\"max_credits\":1},"
    done
    post "/v1/batches" "{\"items\":[${items%,}]}"
    ;;

  batch-status)
    need_jq
    get "/v1/batches/${1:?BATCH_ID required}" | jq '{status, total_items, succeeded_items, failed_items, cancelled_items, items}'
    ;;

  upload)
    # 1. Reserve a slot, 2. PUT the bytes to the signed URL (WITHOUT your API key),
    # 3. mark it complete, 4. transcribe it. Uploads always use AI transcription.
    need_jq
    file="${1:?FILE required}"
    type="$(safe "${2:?content type required, e.g. audio/mpeg}")"
    max="$(num "${3:-20}")"
    name="$(safe "$(basename "$file")")"
    bytes="$(wc -c < "$file" | tr -d ' ')"
    need_key
    slot="$(curl -sS --fail-with-body -X POST \
      -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"filename\":\"$name\",\"content_type\":\"$type\",\"bytes\":$bytes}" \
      "$API/v1/uploads")"
    upload_id="$(printf '%s' "$slot" | jq -r .id)"
    signed_url="$(printf '%s' "$slot" | jq -r .signed_upload_url)"
    curl -sS --fail-with-body -X PUT -H "Content-Type: $type" --data-binary "@$file" "$signed_url" >/dev/null
    curl -sS --fail-with-body -X POST \
      -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY" \
      "$API/v1/uploads/$upload_id/complete" >/dev/null
    post "/v1/jobs" "{\"source\":{\"upload_id\":\"$upload_id\"},\"mode\":\"transcribe\",\"max_credits\":$max}"
    ;;

  jobs)
    get "/v1/jobs?limit=10"
    ;;

  cancel)
    need_key
    curl -sS --fail-with-body -X POST \
      -H "Authorization: Bearer $TRANSCRIPTDOCK_API_KEY" \
      "$API/v1/jobs/${1:?JOB_ID required}/cancel"
    ;;

  retry)
    # A retry is a new job, so it takes a new idempotency key and its own cap.
    id="${1:?JOB_ID required}"
    if [ -n "${2:-}" ]; then body="{\"max_credits\":$(num "$2")}"; else body="{}"; fi
    post "/v1/jobs/$id/retry" "$body"
    ;;

  help | -h | --help)
    usage
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac
