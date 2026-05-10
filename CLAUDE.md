# Claude Operating Notes

This file tells coding agents how to work in the Aether repo without overstating hardware or sensing capability.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Source modes are explicit: `LIVE` and `REPLAY`.
- [Confirmed in docs] current scope is live CSI capture, storage, replay, UI visualization, controlled experiments, KB search, and grounded summaries.
- [Unknown / needs verification] Hardware CSI validity requires flashing and observing two ESP32-S3 boards.

## Rules

- Do not claim heartbeat, HRV, identity, emotion, through-wall sensing, or medical meaning in V0.
- Never silently substitute replay data for live data.
- Label claims in docs and reports as `[Confirmed in code]`, `[Confirmed in docs]`, `[Observed in hardware]`, `[Inference]`, or `[Unknown / needs verification]`.
- Keep firmware callbacks short; queue CSI work out of the Wi-Fi task.
- Prefer deterministic tools and structured summaries over raw tensor reasoning for agent features.

## Current Vertical Slice

The first slice is:

```text
replay/live collector -> protocol models -> event bus -> DSP windows -> API/WebSocket -> UI -> reports/KB/agent tools
```

Future hardware rails should be adapters into the same raw-frame and derived-window contracts.
