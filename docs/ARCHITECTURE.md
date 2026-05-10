# Architecture

Purpose: explain the system boundaries and data flow.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Replay, serial parser, DSP, API, UI, KB, and agent tools are separated by contracts.
- [Unknown / needs verification] NATS, learned models, and multimodal fusion are future work.

## Flow

```text
ESP32-S3 TX -> Wi-Fi packets
ESP32-S3 RX -> CSI callback -> queue -> serial frames
Host collector -> parser -> RawCsiFrame -> storage + event bus
DSP -> DerivedWindow -> API/WebSocket
Web UI -> live field, telemetry, experiments, reports
KB/Agent -> structured summaries only
```

## Modes

- `REPLAY`: stored sessions replayed through the same bus.
- `LIVE`: serial frames from the RX board.

## Extension Points

- Collector adapters own hardware-specific normalization.
- Protocol schemas own cross-service compatibility.
- DSP modules own deterministic measurements.
- Agent tools consume summaries, never raw CSI tensors.
