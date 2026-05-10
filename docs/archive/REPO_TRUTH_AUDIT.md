# Repository Truth Audit

Purpose: record what is actually present in the repository before and after the V0 scaffold.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] The starting workspace was an empty Git repository with no commits and no tracked files.
- [Confirmed in code] The V0 scaffold now defines docs, protocol contracts, host services, a web app, firmware projects, scripts, and tests.
- [Unknown / needs verification] No hardware output has been observed in this workspace yet.
- [Unknown / needs verification] Python and pnpm were not available on the current PATH during initial implementation.

## Current Repository Reality

- Root config: `README.md`, `CLAUDE.md`, `.env.example`, `pyproject.toml`, `package.json`, `pnpm-workspace.yaml`, `docker-compose.yml`, `Makefile`.
- Firmware: `firmware/esp32-s3-tx` and `firmware/esp32-s3-rx`.
- Host services: `apps/api`, `services/collector`, `services/dsp`, `services/kb`, `services/agent`.
- UI: `apps/web`.
- Contracts: `packages/protocol`.
- Operational material: `docs`, `scripts`, `tests`, `data`.

### DSP layer (post-bring-up)

- `services/dsp/src/filters.py` — Hampel outlier rejection, Butterworth bandpass, linear detrend, dB conversion, uniform resampling. Built on numpy + scipy.
- `services/dsp/src/calibration.py` — `BaselineCalibrator` running Welford accumulator over per-subcarrier amplitude. Exposes `subtract_baseline`, `snr_weights`, `select_responsive_subcarriers`, `status`.
- `services/dsp/src/features.py` — Per-window amplitude matrix, edge-subcarrier drop, Hampel-per-column, baseline subtract, detrend, bandpass 0.05–5 Hz, SNR-weighted motion / anomaly. Surfaces `packet_loss_ratio`, `first_word_invalid_ratio`, `jitter_ms`, `expected_packet_rate_hz`, `baseline_calibrated`.
- `services/dsp/src/biorhythm.py` — Per-frame full amplitude buffer, edge drop, top-K subcarrier selection by std, Hampel + uniform resample + 0.05–3 Hz bandpass, Hann window + rFFT. Reports respiration / heart proxy / fidget energy with prominence-based confidence.

### Calibration / runtime / collector

- `apps/api/src/services/runtime.py` — Owns the `BaselineCalibrator`, feeds raw frames into it during `is_calibrating`, passes it to `derive_window`. Tracks `expected_packet_rate_hz`.
- `apps/api/src/api/routes.py` — `GET / POST / DELETE /calibration/baseline`, `POST /calibration/baseline/cancel`.
- `services/collector/src/serial_reader.py` — Auto-reconnect with exponential backoff and read-stall watchdog.

### UI

- `apps/web/features/radio-vision-console.tsx` — Live Room now includes a `CalibrationCard` with progress meter and Calibrate / Reset / Cancel controls. `SignalQualityCard` shows packet rate vs target, packet loss, invalid-frame ratio, jitter, RSSI.

## Verification Labels

All docs and reports should use:

- `[Confirmed in code]`
- `[Confirmed in docs]`
- `[Observed in hardware]`
- `[Inference]`
- `[Unknown / needs verification]`

## Risks

- [Unknown / needs verification] ESP-IDF and Python setup are local-machine prerequisites.
- [Inference] Hardware bring-up will need iteration around serial framing, board variant, antenna, channel, and packet cadence.
