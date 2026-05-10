# Setup

Local-development setup for Aether V0. For the absolute fastest path on
a fresh clone, see [README.md](../README.md#quickstart).

## What is confirmed / what is unknown

- [Confirmed in code] Every command below is what the project actually runs.
- [Confirmed in code] `.env` at the repo root is auto-loaded by
  `apps/api/src/config.py`. Shell environment wins over file values.
- [Unknown / needs verification] ESP-IDF firmware flashing assumes the boards
  are physically connected; verified on Windows with ESP32-S3-DevKitC-1 boards
  on CH343 USB-to-UART bridges.

## Prerequisites

| Tool | Min version | Why |
|---|---|---|
| Node.js | 22 | Next.js 16 / Turbopack |
| Python | 3.12 | Pydantic v2, FastAPI ≥ 0.115 |
| ESP-IDF | 5.x | Optional; only for re-flashing TX/RX firmware |

`pnpm` is listed in `package.json` (`packageManager: pnpm@9.15.4`) but the
plain `npm` workspace flow used below works identically.

## One-time host setup

```powershell
# 1. Install Node + Python deps
npm install
python -m venv .venv
. .\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
```

## Auto-detect your boards (Windows)

If you have the TX/RX boards connected, this script enumerates COM ports,
probes each one for CSI traffic, and writes `.env` with the right port.
Idempotent. Safe to re-run.

```powershell
.\scripts\setup_local.ps1
# .\scripts\setup_local.ps1 -Force        # re-detect even if .env exists
# .\scripts\setup_local.ps1 -Port COM5    # skip probe and pin a port
```

You should see something like:

```
[setup] USB-serial ports on this PC:
  COM9   USB-Enhanced-SERIAL CH343 (COM9)
  COM10  USB-Enhanced-SERIAL CH343 (COM10)
[setup] probing each port for CSI traffic (4 s each)...
  COM9   -> RED open failed: PermissionError(13, ...)
  COM10  -> GREEN csi=44 hb=4
[setup] selected RX port: COM10
[setup] wrote new .env with AETHER_SERIAL_PORT=COM10
```

If you don't have hardware yet, copy `.env.example` to `.env` and set the
serial port manually later.

## Run the API

```powershell
. .\.venv\Scripts\Activate.ps1   # if not already active
python -m uvicorn apps.api.src.main:app --reload --host 127.0.0.1 --port 8000
```

The first log lines should show the loaded settings, e.g.:

```
[boot] settings source_mode=LIVE host=127.0.0.1 port=8000 serial_port=COM10 baud=115200 ...
```

If `serial_port=None`, the `.env` wasn't loaded — check the file is at the
**repo root**, not under `apps/api/`.

## Run the web UI

In a separate terminal:

```powershell
npm run web:dev
# or: npm run dev
```

Then open <http://localhost:3000>. The Live Room page shows a Readiness
checklist that turns each gate green as the system comes up.

## Run the test suite

```powershell
# Frontend / contract tests
npm test

# Backend tests
. .\.venv\Scripts\Activate.ps1
python -m pytest -q
```

These three are exactly what runs on push (see `.github/workflows/ci.yml`):
`npm test`, `python -m pytest`, and `tsc --noEmit` on the web workspace.

## Replay mode (no hardware)

To drive the UI from a recorded session instead of live serial:

```powershell
$env:AETHER_REPLAY_PATH = "data/recordings/<session-id>.jsonl"
python -m uvicorn apps.api.src.main:app --reload --host 127.0.0.1 --port 8000
```

The boot line will switch to `source_mode=REPLAY` and the UI's source badges
will all read **REPLAY** so nobody mistakes it for live data.

## Where to look when something breaks

- `docs/DEBUGGING.md` — log tag reference (`[boot] [http] [route] [ws]
  [runtime]` server, `[rv:boot] [rv:api] [rv:ws] [rv:error]` browser).
- `docs/TROUBLESHOOTING.md` — symptom-to-fix recipes for the most common
  setup snags (Python version, pnpm, serial port, packet rate).
- `PROBLEMS.md` (repo root) — current known issues with root-cause analysis
  and suggested fixes, kept honest.
