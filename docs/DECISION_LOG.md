# Decision Log

Purpose: record implementation decisions and deviations.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Initial repo was empty, so structure was created from the build spec.
- [Unknown / needs verification] Some runtime commands are unverified until Python/pnpm/ESP-IDF are installed.

## Decisions

### 2026-05-09: Replay before live hardware

- Decision: keep `REPLAY` for recorded sessions and remove non-real runtime generation.
- Reason: must never fabricate device measurements.

### 2026-05-09: Enterprise UI dependencies

- Decision: add `@tanstack/react-table`, `@tanstack/react-virtual`, and `uplot`; remove decorative 3D/charting dependencies.
- Reason: the refactor requires real data tables, row virtualization, and lightweight instrument charts.

### 2026-05-09: Structured summaries for agent

- Decision: agent tools expose summaries and derived windows, not raw CSI arrays.
- Reason: deterministic measurements keep uncertainty visible and avoid unsupported claims.

### 2026-05-09: Line-delimited JSON serial V0

- Decision: use newline-delimited JSON from firmware first.
- Reason: easier bring-up and debugging; binary framing can follow throughput measurements.

### 2026-05-10: Conditioning + calibration before scoring

- Decision: every derived window now passes through edge-subcarrier drop, per-column Hampel, baseline subtraction, linear detrend, and Butterworth bandpass (0.05–5 Hz for motion, 0.05–3 Hz for biorhythm) before any score is computed; an explicit `BaselineCalibrator` is required for `occupancy_score` and `anomaly_score` to be meaningful.
- Reason: with two ESP32-S3 boards in a noisy 2.4 GHz environment, raw amplitude variance is dominated by AGC drift, edge-subcarrier hardware artefacts, and impulsive noise from `first_word_invalid` packets. Without conditioning the motion / occupancy scores either flatlined at zero (when used as their own baseline) or were so noisy a person walking through the link did not visibly perturb them. Filtering and a real empty-room baseline are the lowest-cost path to a working demo.

### 2026-05-10: Surface link diagnostics in DerivedWindow

- Decision: add optional `packet_loss_ratio`, `first_word_invalid_ratio`, `jitter_ms`, `expected_packet_rate_hz`, `baseline_calibrated` fields to `DerivedWindow.v1`; expose them in the API and the Live Room UI.
- Reason: when the link is bad we need the operator to see *why*. The previous `quality_score` collapsed all of this into a single number, which made it impossible to tell jitter from packet loss from invalid frames.

### 2026-05-10: Auto-reconnect on serial

- Decision: `read_serial_frames` now wraps the serial port in an exponential-backoff watchdog with a 10 s read-stall timeout.
- Reason: hardware bring-up routinely drops USB connections. The previous behaviour was to raise and stop the live source task, which left the API in a permanently dead state.

### 2026-05-10: Hallucination audit + remove HRV / Stress / Affect cards

- Decision: removed the HRV-proxy (in ms) and Stress/Affect tone cards from the Live Room. Renamed the "Heart-rate proxy" card to "Periodic motion in HR band". Created `docs/VITAL_SIGNS_REALITY.md` detailing what the system does and does not do.
- Reason: the HRV proxy was a heuristic with clinical units (`spread(heartSeries) * 60000/bpm / bpm`, clamped 4–200 ms) and no physiological grounding; the Stress/Affect card mapped a weighted blend of fidget + (1 − quality) + (1 − resp_conf) + anomaly/18 onto Calm/Focused/Stressed labels. Both violate the project's own rule (`CLAUDE.md`) against claiming HRV, identity, emotion, or medical meaning in V0. The HR-band card itself is kept because the FFT peak there is a real measurement, but it is now gated by stillness, FFT/ACF agreement, and a not-a-respiration-harmonic check.

### 2026-05-10: Add CSI-ratio path, ACF cross-check, harmonic confidence, EWMA tracker, stillness gate

- Decision: rewrite `services/dsp/src/biorhythm.py` to (a) compute the complex CSI-ratio between adjacent subcarriers as the primary signal source, falling back to |CSI| when the ratio is degenerate; (b) cross-check FFT-peak BPM against autocorrelation-peak BPM and halve confidence when they disagree; (c) score peak prominence at the 2nd harmonic and bump confidence when it is also prominent; (d) suppress HR-band BPM when its peak is ~2× respiration's peak (likely a respiration harmonic); (e) gate all vital-sign output behind a `motion_score` threshold; (f) smooth published BPMs through a confidence-weighted EWMA tracker.
- Reason: the previous estimator picked the strongest spectral peak with prominence-only confidence. On real ESP32-S3 PCB-antenna links at 2 m this routinely surfaced respiration's 2nd harmonic as a "heart rate", and produced a per-window BPM dance that looked like instability rather than measurement. The CSI-ratio path is the documented best practice for vital signs from COTS Wi-Fi (Wang et al., SenSys 2017); the cross-check and gate reduce false BPMs.
