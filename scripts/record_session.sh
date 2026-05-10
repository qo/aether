#!/usr/bin/env sh
set -eu

API="${API:-http://127.0.0.1:8000}"
PROTOCOL="${PROTOCOL:-empty_room_baseline}"

curl -sS -X POST "$API/sessions" \
  -H "content-type: application/json" \
  -d "{\"protocol\":\"$PROTOCOL\",\"notes\":\"record_session.sh\"}"
