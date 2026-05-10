# Refactor Completion

Purpose: summarize the Radio Vision simulation purge and enterprise UI refactor.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Runtime source modes are now `LIVE` and `REPLAY` only.
- [Confirmed in code] The UI no longer seeds fabricated windows or summaries.
- [Confirmed in code] The no-fake-data check is part of `npm test`.
- [Unknown / needs verification] Python tests were not run because Python is not on PATH in this environment.
- [Unknown / needs verification] Hardware tests were not run because ESP-IDF and boards were not available.

## Files Changed

- `.env.example`
- `docker-compose.yml`
- `package.json`
- `package-lock.json`
- `README.md`
- `CLAUDE.md`
- `apps/api/src/config.py`
- `apps/api/src/main.py`
- `apps/api/src/api/routes.py`
- `apps/api/src/services/runtime.py`
- `apps/api/src/services/session_store.py`
- `apps/api/tests/test_session_store.py`
- `apps/web/package.json`
- `apps/web/app/layout.tsx`
- `apps/web/app/globals.css`
- `apps/web/features/radio-vision-console.tsx`
- `apps/web/lib/api.ts`
- `apps/web/lib/types.ts`
- `apps/web/components/source-badge.tsx`
- `apps/web/components/metric-card.tsx`
- `packages/protocol/schemas/csi_frame.schema.json`
- `packages/protocol/schemas/derived_window.schema.json`
- `packages/protocol/schemas/experiment_event.schema.json`
- `packages/protocol/python/aether_protocol/models.py`
- `packages/protocol/typescript/src/index.ts`
- `services/dsp/src/respiration.py`
- `services/dsp/tests/test_features.py`
- `scripts/replay_session.ps1`
- `scripts/replay_session.sh`
- `tests/e2e/protocol-schema.test.mjs`
- `docs/APP_BLUEPRINT.md`
- `docs/ARCHITECTURE.md`
- `docs/DECISION_LOG.md`
- `docs/DEFINITIVE_STACK.md`
- `docs/PROTOCOL.md`
- `docs/ROADMAP.md`
- `docs/TESTING.md`

## Files Added

- `docs/PURGE_AUDIT.md`
- `docs/UI_AUDIT.md`
- `docs/REFACTOR_COMPLETION.md`
- `packages/ui/design-system.ts`
- `apps/web/components/status-dot.tsx`
- `apps/web/components/confidence-badge.tsx`
- `apps/web/components/event-tag.tsx`
- `apps/web/components/section-header.tsx`
- `apps/web/components/empty-state.tsx`
- `apps/web/components/disconnected-banner.tsx`
- `apps/web/components/sparkline.tsx`
- `apps/web/components/data-table.tsx`
- `apps/web/components/waterfall-canvas.tsx`
- `apps/web/components/amplitude-chart.tsx`
- `apps/web/tests/component-fixture.tsx`
- `scripts/no_nonreal_data_check.mjs`
- `data/fixtures/.gitkeep`

## Deleted Paths

- `services/collector/src/simulator.py`
- `apps/web/components/rf-field.tsx`
- `apps/web/components/trend.tsx`
- `apps/web/components/waterfall.tsx`

## Tests Run

- `npm test`: passed.
- `npm run web:build`: passed.
- `npm audit --omit=dev`: failed with 2 moderate advisories from Next's PostCSS dependency chain; npm reports the available force fix would downgrade Next and is not acceptable as an automatic refactor step.

## Tests Not Run

- Python tests: skipped because `python` and `py` are not available on PATH.
- Firmware/hardware checks: skipped because ESP-IDF and physical ESP32-S3 boards are not available in this environment.

## Current Known Gaps

- Knowledge Base and Agent Console show explicit unavailable states because no existing API endpoint exposes KB search or agent tool output.
- Data Explorer can show sessions, summaries, current derived window data, and export actions, but raw-frame pagination and event listing are not exposed by existing endpoints.
- Devices page can show `/health` and `/devices` data, but firmware version, TX health, and serial selection require future API support.
- Hardware fixture tests skip until `data/fixtures/live_csi_sample.jsonl` is populated with a recorded live session.
