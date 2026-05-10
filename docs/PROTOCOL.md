# Protocol

Purpose: define the cross-service data contracts and serial framing.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] JSON schemas exist for `csi_frame.v1`,
  `derived_window.v1`, `experiment_event.v1`, and `room_geometry.v1`.
- [Confirmed in code] Two non-strict diagnostic surfaces exist
  (`link_diagnostics.v1`, `subcarrier_diagnostics.v1`) — see TS mirror
  for shapes; they are not validated by the JSON Schema test gate because
  they're informative only.
- [Unknown / needs verification] Binary framing may be added after live
  throughput testing.

## Source Modes

Every raw frame and derived window includes `source_mode` with exactly one of:

- `LIVE`
- `REPLAY`

## Serial Lines (RX firmware → host)

The RX firmware emits newline-delimited JSON envelopes. The collector
recognises three `type` values:

- `csi` — CSI payload and metadata. Body matches `csi_frame.v1` minus the
  fields the host adds itself (`session_id`, `ts_host_ns`, `source_mode`).
- `heartbeat` — emitted ~1 Hz. Carries `packets_seen`, `dropped`,
  `queue_depth`, `uptime_us`, `firmware`. The runtime feeds `dropped` and
  `queue_depth` into LinkStats so they show up in `/diagnostics/link` and
  the Devices/Raw Sensor pages.
- `status` — firmware-defined free-form; logged but not parsed.

The collector rejects malformed frames and never silently switches
source mode. Heartbeat envelopes ride the same `read_serial_frames()`
async iterator as CSI frames; the runtime dispatches on `isinstance`.

## REST surfaces

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | API liveness + source mode. |
| GET | `/devices` | RX/TX status + the same observed/expected Hz that `/diagnostics/link` returns. |
| POST/GET/DELETE | `/sessions[/{id}/...]` | Session lifecycle, events, summary, export. |
| GET | `/sessions/{id}/frames` | Page of raw `csi_frame.v1` records (`from_ns` / `to_ns` / `limit`, max 2000). |
| GET | `/sessions/{id}/frames/latest?n=` | Tail-N raw frames (max 500). |
| GET / POST / DELETE / POST | `/calibration/baseline[...]` | Baseline calibration (acceptance gates from v0.2 may put `accepted=false` with `last_rejection_reason`). |
| GET | `/diagnostics/link` | EMA-smoothed observed packet rate, inter-arrival p50/p90/p99/max ms, jitter σ, RSSI median+std, noise floor median, firmware drop count + queue depth, notes. |
| GET | `/diagnostics/subcarriers` | Per-subcarrier baseline mean+std, SNR weights, kept-after-edge-trim indices, current responsive subset. |
| GET / PUT | `/room/geometry` | Operator-supplied room/TX/RX/subject geometry (`room_geometry.v1`). |
| GET | `/room/summary` | Roll-up of latest derived window. |

## WebSocket `/ws/live` topics

Default subscription is `["derived_window"]`. A client can change topics any
time by sending:

```json
{ "type": "subscribe", "topics": ["derived_window", "raw_frame"] }
```

Server-emitted message types:

- `hello` — sent once on connect. Includes `summary` and
  `available_topics`.
- `subscribed` — ack to a `subscribe` request, echoes the resolved topic
  set.
- `derived_window` — full `derived_window.v1` plus `summary`. Emitted at
  the DSP rate (~window-per-half-second at 20 Hz).
- `raw_frame` — full `csi_frame.v1` plus a server-computed `derived`
  block (`amplitude[]`, `phase[]`, `subcarrier_count`). Rate-limited to
  ~30 Hz per client.

The server never sends `raw_frame` to a client that didn't subscribe to it.
