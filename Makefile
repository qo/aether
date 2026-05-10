.PHONY: setup dev api web test hardware-check flash-tx flash-rx record replay analyze

setup:
	npm install
	python -m venv .venv
	.venv/bin/python -m pip install -e ".[dev]"

dev:
	npm run dev

api:
	python -m uvicorn apps.api.src.main:app --reload --host 127.0.0.1 --port 8000

web:
	npm run web:dev

test:
	npm test
	python -m pytest

hardware-check:
	powershell -ExecutionPolicy Bypass -File scripts/hardware_check.ps1

flash-tx:
	powershell -ExecutionPolicy Bypass -File scripts/flash_tx.ps1

flash-rx:
	powershell -ExecutionPolicy Bypass -File scripts/flash_rx.ps1

record:
	powershell -ExecutionPolicy Bypass -File scripts/record_session.ps1

replay:
	powershell -ExecutionPolicy Bypass -File scripts/replay_session.ps1

analyze:
	powershell -ExecutionPolicy Bypass -File scripts/analyze_session.ps1
