# Testing

Purpose: define automated and manual verification for V0.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] A Node protocol smoke test is available.
- [Unknown / needs verification] Python tests require Python 3.12 and dependencies.
- [Unknown / needs verification] Hardware tests require two boards.

## Automated Tests

- Schema structure and required fields.
- Serial parser.
- DSP feature extraction.
- Storage round trips.
- KB search.
- Agent tool outputs.
- UI rendering after dependencies are installed.

## No-Fake-Data Contract

`npm test` runs the protocol contract smoke test and `scripts/no_nonreal_data_check.mjs`.

The check scans runtime code and docs for the configured banned non-real data markers. It excludes test directories, `data/fixtures/`, and audit/completion reports so findings and hardware fixtures can remain explicit.

If the check fails, remove the non-real runtime path or move test-only material into the approved fixture/test locations.

## Manual 10-Minute Test

1. Flash TX and RX.
2. Run hardware check.
3. Start API and UI.
4. Confirm `LIVE` source mode.
5. Record empty baseline.
6. Add enter/motion labels.
7. Replay session.
8. Generate report.
