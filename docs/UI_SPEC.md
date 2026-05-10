# UI Spec

Purpose: define the browser interface.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] The app shell contains all required pages.
- [Unknown / needs verification] Final mobile layout should be checked in browser after dependency install.

## Design Rules

- The first screen is the working instrument, not a landing page.
- Source mode is visible at all times.
- Respiration is labeled experimental.
- Agent answers show tool provenance and uncertainty.
- Dense telemetry is preferred over marketing-style cards.

## Core Components

- Readiness checklist (API/WebSocket/serial port/session/frames/calibration gates).
- Disconnected banner with a reason-coded actionable hint.
- Subcarrier-time map (rows = subcarriers, columns = time, intensity = amplitude std).
- Subcarrier amplitude bars.
- Motion / occupancy / anomaly / quality trend lines (uPlot).
- Respiration & HR-band cards with FFT/ACF cross-check, harmonic and stillness gates (research-only).
- Session and device status panels with honest "streaming / no frames yet / stalled / not configured" states.

Removed in the May 2026 refactor: a decorative "RF wave field" component (it
encoded no measurement). See `docs/REFACTOR_COMPLETION.md`.
