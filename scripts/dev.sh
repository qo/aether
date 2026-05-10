#!/usr/bin/env sh
set -eu

echo "Start API:"
echo "  python -m uvicorn apps.api.src.main:app --reload --host 127.0.0.1 --port 8000"
echo "Start UI:"
echo "  npm run web:dev"
