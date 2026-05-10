#!/usr/bin/env sh
set -eu

: "${SESSION_ID:?Set SESSION_ID to replay.}"

echo "Recording path: data/recordings/${SESSION_ID}.jsonl"
echo "Set AETHER_REPLAY_PATH to this path before starting the API."
