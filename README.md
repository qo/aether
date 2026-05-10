# Aether

A **local-first Wi-Fi CSI sensing instrument**. Two ESP32-S3 boards bracket a
seated subject; the RX board emits raw 802.11n Channel State Information per
packet over USB; a Python collector + DSP pipeline turns those frames into
motion / occupancy / signal-quality / (research-only) respiration windows; a
Next.js console renders them in real time.

No camera. No microphone. No cloud. No identity, emotion, or medical claims.

```
  ESP32-S3 TX  )))  Wi-Fi 2.4 GHz multipath  (((  ESP32-S3 RX
                                                       |
                                          USB-CDC @ 115200 (CH343)
                                                       v
     pyserial -> InMemoryEventBus -> DSP windows -> SQLite + JSONL
                            |               |
                            +-------- FastAPI + WebSocket /ws/live -> Next.js UI
```

## Quickstart

Two terminals, ~2 minutes from a fresh clone if you have hardware.

```powershell
# Terminal 1 - one-time setup, then API
npm install                                    # web + workspace deps
python -m venv .venv
. .\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"              # backend + tests

.\scripts\setup_local.ps1                      # auto-detects RX COM port,
                                               # writes .env at repo root

python -m uvicorn apps.api.src.main:app --reload --host 127.0.0.1 --port 8000
# look for: [boot] settings source_mode=LIVE serial_port=COM10 ...
```

```powershell
# Terminal 2 - web UI
npm run web:dev
# open http://localhost:3000
```

In the UI:

1. **Live Room → Readiness** — first three rungs go green: API reachable,
   WebSocket connected, Serial port configured.
2. Click **Start session** in the disconnected banner (or use Experiment
   Console → Create session).
3. Within ~5 s, **CSI frames flowing** turns green and live charts populate.
4. Hold the room empty → **Calibrate (10 s)** in the Baseline Calibration
   card. Without baseline, occupancy reads "uncalibrated".

### No hardware? Replay mode

```powershell
$env:AETHER_REPLAY_PATH = "data/recordings/<session-id>.jsonl"
python -m uvicorn apps.api.src.main:app --reload
# UI source badges all switch to REPLAY so it cannot be confused with live data
```

## Documentation

| File | What it covers |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Full setup, prerequisites, replay mode, where to look when broken |
| [`docs/DEBUGGING.md`](docs/DEBUGGING.md) | Log tag reference for every layer; filter recipes for browser + API |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Symptom → fix recipes (Python version, pnpm, serial port, packet rate) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Service boundaries, data flow, transport contracts |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Wire schemas (`csi_frame.v1`, `derived_window.v1`, `experiment_event.v1`) |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Storage entities, retention, privacy fields |
| [`docs/FIRMWARE.md`](docs/FIRMWARE.md) | TX/RX firmware roles, flash scripts |
| [`docs/DEVICE_REALITY.md`](docs/DEVICE_REALITY.md) | Honest hardware notes (geometry, baseline requirement) |
| [`docs/VITAL_SIGNS_REALITY.md`](docs/VITAL_SIGNS_REALITY.md) | Why HR is research-only on this hardware |
| [`docs/ETHICS_AND_PRIVACY.md`](docs/ETHICS_AND_PRIVACY.md) | Boundaries: no probe requests, no identity/emotion/medical |
| [`docs/EXPERIMENT_PLAN.md`](docs/EXPERIMENT_PLAN.md) | current protocols (empty room, presence, motion, breathing, sweeps) |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Vision through V3 |
| [`docs/DECISION_LOG.md`](docs/DECISION_LOG.md) | Major design decisions, dated |
| [`PROBLEMS.md`](PROBLEMS.md) | Known issues, root causes, things to fix later |
| [`CLAUDE.md`](CLAUDE.md) | Operating notes for AI coding agents in this repo |

## Tech stack (one-liner)

ESP32-S3 + ESP-IDF firmware → CH343 USB-serial → Python 3.12 + pyserial +
asyncio pub/sub bus → NumPy/SciPy DSP (FFT + ACF + bandpass + baseline
calibration) → Pydantic v2 protocol models → SQLite + JSONL storage →
FastAPI + Uvicorn + native WebSocket → Next.js 16 + React 19 + TypeScript +
Turbopack + uPlot + TanStack Table/Virtual.

Local-first throughout. No cloud, no auth, no telemetry, no hidden state.

## Repository layout

```
apps/
  api/                 FastAPI service: routes, WebSocket, runtime, session store
  web/                 Next.js 16 app: features/, components/, lib/

services/
  collector/           pyserial reader + replay reader + in-memory bus
  dsp/                 features, calibration, biorhythm, summaries
  kb/                  knowledge-base search (V1 scaffolding, not yet wired)
  agent/               grounded-agent + MCP tools (V1 scaffolding, not yet wired)

packages/
  protocol/python/     Pydantic models (single source of truth)
  protocol/typescript/ TS mirror
  protocol/schemas/    JSON Schemas (validated by tests/e2e/)
  ui/                  Shared design tokens

firmware/
  esp32-s3-tx/         CSI-emitter board (transmit-only)
  esp32-s3-rx/         CSI-capture board (CSI callback → JSON over USB)

scripts/
  setup_local.ps1      Auto-detects boards, writes .env (Windows)
  probe_serial.py      Opens given COM ports for 4 s, reports CSI/heartbeat
  hardware_check.ps1   One-port hardware confirmation
  flash_tx.ps1 / .sh   Build + flash via idf.py
  flash_rx.ps1 / .sh
  record_session.ps1   Convenience wrappers around the API
  replay_session.ps1
  no_nonreal_data_check.mjs   CI guard against fake/mock/synthetic data

docs/                  Markdown reference - see table above
data/
  recordings/          Per-session raw + derived JSONL (gitignored)
  exports/             Session report bundles (gitignored)
  fixtures/            Tiny test inputs (kept in git)
```

## Tests + CI

```powershell
npm test                                 # protocol schema + no-fake-data scan
python -m pytest -q                      # 38 backend tests
npx tsc --noEmit -w @aether/web    # frontend typecheck
```

GitHub Actions (`.github/workflows/ci.yml`) runs all three on push.

## Project status

**Current.** Live CSI capture, storage, replay, real-time UI, controlled
experiments, structured logging, baseline calibration, FFT/ACF respiration
research-only readout. Single-room, single-subject, single-link.

**V1 / later.** See `docs/ROADMAP.md` and `PROBLEMS.md` for what's scaffolded
but not wired (agent + KB) and what's known broken/unfinished.

## License + scope

Internal research project. Hardware-dependent; no public deploy. Read
`docs/ETHICS_AND_PRIVACY.md` before recording sessions.
