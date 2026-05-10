# Protocol

Purpose: define the cross-service data contracts and serial framing.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] JSON schemas exist for `csi_frame.v1`, `derived_window.v1`, and `experiment_event.v1`.
- [Unknown / needs verification] Binary framing may be added after live throughput testing.

## Source Modes

Every raw frame and derived window includes `source_mode` with exactly one of:

- `LIVE`
- `REPLAY`

## Serial Lines

The RX firmware emits newline-delimited JSON with `type`:

- `csi`: CSI payload and metadata.
- `status`: firmware version, uptime, channel, packet counters.
- `heartbeat`: liveness marker.

The collector rejects malformed frames and never silently switches source mode.
