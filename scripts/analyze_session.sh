#!/usr/bin/env sh
set -eu

: "${SESSION_ID:?Set SESSION_ID to analyze.}"
API="${API:-http://127.0.0.1:8000}"

curl -sS "$API/sessions/$SESSION_ID/summary"
