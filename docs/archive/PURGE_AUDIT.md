# Purge Audit

Purpose: record all non-real data paths found before deleting or replacing them.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Runtime simulation exists in the API, collector, protocol contracts, tests, UI seed data, and docs.
- [Confirmed in code] Replay exists as a separate production path and should be kept.
- [Unknown / needs verification] No recorded hardware fixture exists yet under `data/fixtures/`.

## Audit Method

Searched repo files outside `node_modules`, `.git`, and `.next` for:

`sim`, `simulate`, `simulation`, `mock`, `fake`, `stub`, `dummy`, `synthetic`, `generated`, `placeholder`, `demo`, `replay`, `setTimeout`, `setInterval`, `Math.random`, `SIMULATED`, `AETHER_SOURCE_MODE`, `source_mode`.

## Findings

| File:line | What it does | Real path impact | Action |
|---|---|---|---|
| `.env.example:1` | Sets `AETHER_SOURCE_MODE=SIMULATED`. | Blocks honest default by selecting non-real data mode. | DELETE |
| `docker-compose.yml:11` | Starts API with simulated source mode. | Blocks honest default in container flow. | DELETE |
| `apps/api/src/config.py:12,26` | Defines `source_mode` and defaults to `SIMULATED`. | Blocks honest default; permits non-real runtime. | REPLACE WITH REAL |
| `apps/api/src/config.py:17,31` | Defines replay path. | Parallel production replay path. | KEEP |
| `apps/api/src/main.py:31-38` | Auto-creates and starts a simulated session on startup. | Blocks real state by fabricating live windows. | DELETE |
| `apps/api/src/api/routes.py:35,50,109` | Uses configured source mode in devices/session/event responses. | Needed for live/replay after enum purge. | REPLACE WITH REAL |
| `apps/api/src/api/routes.py:39` | Reports RX status as simulated when source mode is simulated. | Fabricates device status. | DELETE |
| `apps/api/src/api/routes.py:74-75` | Starts simulator when session starts. | Blocks real-only runtime. | DELETE |
| `apps/api/src/api/routes.py:76-79` | Starts replay from stored path. | Production replay behavior. | KEEP |
| `apps/api/src/api/routes.py:80-83` | Starts live serial collector. | Real hardware path. | KEEP |
| `apps/api/src/services/runtime.py:12` | Imports simulator generator. | Non-real runtime dependency. | DELETE |
| `apps/api/src/services/runtime.py:52-65` | Emits simulator frames on interval. | Blocks real-only runtime. | DELETE |
| `apps/api/src/services/runtime.py:67-81` | Replays recorded JSONL frames. | Production replay behavior. | KEEP |
| `apps/api/src/services/session_store.py:171` | Report text says recorded or simulated session. | Documentation/report dishonesty after purge. | REPLACE WITH REAL |
| `services/collector/src/simulator.py:1-58` | Creates synthetic CSI frames. | Non-real data path. | DELETE |
| `services/collector/src/replay.py:1-17` | Reads recorded JSONL frames and marks them REPLAY. | Production replay behavior. | KEEP |
| `services/dsp/src/respiration.py:7` | Uses word placeholder in docstring; code returns null respiration. | Not fake data; wording conflicts with audit terms. | REPLACE WITH REAL |
| `services/dsp/tests/test_features.py:3,12-13` | Uses simulator to test DSP. | Test depends on non-real generator. | REPLACE WITH FIXTURE |
| `apps/api/tests/test_session_store.py:9-10` | Creates simulated session in test. | Test depends on deleted enum. | REPLACE WITH LIVE/REPLAY |
| `tests/e2e/protocol-schema.test.mjs:21` | Expects `SIMULATED` in schema enum. | Test enforces deleted schema value. | REPLACE WITH REAL |
| `packages/protocol/python/aether_protocol/models.py:12` | Defines `SIMULATED` enum. | Permits non-real source mode. | DELETE |
| `packages/protocol/typescript/src/index.ts:1` | Defines `SIMULATED` source mode. | Permits non-real source mode in UI. | DELETE |
| `packages/protocol/schemas/*.schema.json` | Includes `SIMULATED` in `source_mode`. | Permits non-real contract values. | DELETE |
| `apps/web/features/radio-vision-console.tsx:16-38` | Seeds fake derived-window data. | UI fabricates live-looking measurements. | DELETE |
| `apps/web/features/radio-vision-console.tsx:44-52` | Initializes UI with fake windows and summary. | Blocks disconnected state. | REPLACE WITH REAL |
| `apps/web/features/radio-vision-console.tsx:68` | Defaults missing source mode to `SIMULATED`. | Hides disconnected state. | REPLACE WITH REAL |
| `apps/web/features/radio-vision-console.tsx:70-77` | Hardcoded event ticker content. | Mock content not tied to events. | REPLACE WITH EMPTY STATE |
| `apps/web/features/radio-vision-console.tsx:261,278,288` | Displays simulated fallback/status text. | UI exposes non-real mode. | DELETE |
| `apps/web/components/rf-field.tsx:17` | Uses fallback amplitude array when no data exists. | Decorative/fake visualization. | DELETE |
| `apps/web/components/rf-field.tsx:19-51` | Draws decorative RF field canvas. | Purely cosmetic, not a real chart. | DELETE |
| `apps/web/components/waterfall.tsx:5-21` | Renders waterfall from windows, but current UI feeds fake seed data. | Real-capable but needs empty-state handling and enterprise styling. | REPLACE WITH REAL |
| `apps/web/app/globals.css:1-313` | Neon/cyan/scanline/prototype theme. | UI design conflict, not data path. | REPLACE WITH ENTERPRISE SYSTEM |
| `README.md`, `CLAUDE.md`, `docs/*.md`, `scripts/replay_*` | Mention simulator/simulated/demo language. | Docs contradict purge. Replay mentions are production and should stay. | REPLACE WITH REAL / KEEP REPLAY |

## Replay Decision

Replay is not simulation. The replay collector, replay scripts, replay source badge, and replay docs remain because they represent recorded live sessions being re-streamed through the real pipeline.
