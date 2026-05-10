# Vital Signs From CSI: What This System Can And Cannot Do

Purpose: tell operators (and reviewers) exactly what the respiration / heart-rate
band readings in the UI mean, what their accuracy is on this hardware, and
what would be required to make them genuinely trustworthy.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] All displayed numbers flow from real CSI frames through the DSP pipeline in `services/dsp/src/`.
- [Confirmed in code] Removed in this revision: the previous "HRV proxy (ms)" and "Stress / affect" cards, both of which were heuristics dressed up in clinical or affective units; per `CLAUDE.md` they are forbidden in V0.
- [Confirmed in code] The HR-band card now displays a number only when stillness, FFT/ACF agreement, and a not-a-respiration-harmonic check all pass.
- [Inference] Respiration BPM at 1–2 m on this hardware is achievable in a quiet RF environment with a still seated subject and the boards aligned to put the chest in or near the LOS path.
- [Unknown / needs verification] Cardiac BPM at any meaningful accuracy on ESP32-S3 PCB-antenna CSI in a hackathon room is **not supported by published evidence**. Pulse-Fi (UCSC, IEEE DCOSS-IoT 2025) reports ~2-4 BPM error using Pi 4 + dedicated antennas at <1 m in controlled environments. We are below that hardware tier.

## What we display, and how it is computed

| UI card | Underlying computation | Honest interpretation |
|---|---|---|
| Respiration (research) | rFFT peak in 0.10–0.50 Hz on the conditioned, CSI-ratio-cancelled signal; cross-checked against autocorrelation; smoothed by a confidence-weighted EWMA tracker | "There is a periodic perturbation in the breathing band; FFT and ACF agree; here is the smoothed BPM." Treat ±2 BPM. |
| Periodic motion in HR band (research) | rFFT peak in 0.80–2.50 Hz with the same conditioning + ACF + 2x-of-respiration suppression | "There is a periodic perturbation in the heart-rate band that is not a respiration harmonic." Almost never matches a true heart rate on this hardware. |
| Fidget energy | Spectral energy ratio in 2.5–8 Hz | "How much body motion above breathing." |
| Subcarrier-time map | Per-window per-subcarrier amplitude std | "Which subcarriers are being perturbed over time." Real respiration shows up as adjacent rows pulsing in lockstep. |
| Motion / Occupancy / Quality | Bandpass-conditioned, baseline-subtracted, SNR-weighted | Real measurements. |

All vital-sign cards are gated by:
1. `stillness_gated`: motion_score above the calibration-aware threshold suppresses BPM display entirely. Movement dominates the spectrum and any peak would be meaningless.
2. FFT/ACF cross-check: if the two estimators disagree by >5 BPM (resp) or >8 BPM (HR), confidence is halved.
3. Harmonic check: if HR-band peak frequency is within 7% of 2×respiration_peak, it is treated as a respiration harmonic and the HR display is suppressed.
4. Confidence threshold: respiration display requires confidence ≥ 0.30, HR display requires ≥ 0.45 (after the halving above).

## How heart rate is "obtained" — and why it is unreliable on this hardware

The pipeline picks the strongest periodic motion in 0.80–2.50 Hz. In principle that includes the heart-driven micro-displacement of the chest wall. In practice on COTS Wi-Fi 2.4 GHz CSI:

- Cardiac chest displacement is ~0.1 mm. Respiratory chest displacement is ~5–10 mm. The respiration signal is **two orders of magnitude stronger** than the cardiac signal in the same band.
- Respiration produces strong harmonics. A 0.25 Hz fundamental at 60% modulation depth puts a 0.50 Hz harmonic that lands inside the HR band and dominates it.
- ESP32-S3 PCB antennas at 2 m have a per-frame complex CSI noise floor that is comparable to or larger than the cardiac perturbation. The CSI-ratio trick (`services/dsp/src/csi_ratio.py`) cancels common-mode CFO/STO and lifts SNR materially, but it does not turn the antenna into a millimetre-scale instrument.
- Power-line interference (50/60 Hz aliased) and Wi-Fi beacon-rate harmonics also appear in the 0.8–2.5 Hz band on commodity hardware.

For these reasons we labelled the card "Periodic motion in HR band", removed the "HRV (ms)" card entirely, and gate the displayed BPM behind stillness + cross-check + harmonic-rejection.

## How to actually get to clinical-grade BPM (and why we did not promise it)

In rough order of expected return:

1. **Multi-receiver fusion.** Two RX boards perpendicular to the link give angular diversity. Voting across receivers rejects per-link nulls and motion artefacts that affect only one geometry.

2. **Switch to 60 GHz mmWave for cardiac.** Seeed MR60BHA2 (XIAO ESP32-C6 + 60 GHz FMCW radar) ships pre-flashed and gives cross-validation of breathing AND a real cardiac trace at 0.4–1.5 m. Keep CSI for motion / occupancy / scene memory.

3. **Empirical Mode Decomposition (EMD) or Variational Mode Decomposition (VMD).** Decomposes the conditioned signal into intrinsic mode functions; the IMF whose central frequency lands in the breathing band IS the respiration trace, often more cleanly than Butterworth bandpass.

4. **MUSIC / eigenstructure pseudospectrum.** Build a covariance matrix over the conditioned per-subcarrier signal, decompose, and project onto the noise subspace. Peaks are physically tighter than FFT bins, especially on short windows.

5. **Subject-personalised LoRA-style head.** During calibration, capture 30 s of the seated subject WITH a Polar H10 chest strap as ground truth. Fit a small head (logistic regression on spectral features, or a 1D CNN) over the conditioned spectrogram. The model maps "this spectrum" to "this BPM" in this room with this subject. Generalises poorly across rooms / subjects, but excellent for live demo accuracy.

## Geometry: working at ~2 m

For a 2.4 GHz link with TX-RX separation `d`, the first Fresnel zone radius at the link midpoint is:

    r_F = 0.5 * sqrt(λ * d) ≈ 0.5 * sqrt(0.125 m * 2 m) ≈ 0.25 m

So at 2 m the body must be within ~25 cm perpendicular to the LOS path for breathing-induced path-length changes to dominate the CSI. Practical setup notes:

- Place the boards 1.5–2 m apart, both at chest height, facing each other.
- Subject sits on the line between the boards, chest in the LOS path, ~50% of the way across.
- Empty-room baseline (use the **Calibrate** button) is required before occupancy / anomaly mean anything.
- Avoid 2.4 GHz channel 6 in a noisy venue; if possible, reflash the TX firmware to channel 1 or 11 and pick whichever shows the lowest empty-room amplitude std on the subcarrier-time map.
- USB cable runs and active hubs cause jitter; the new diagnostic surface (`SignalQualityCard`) shows jitter in ms. Aim for <2 ms.

## How to validate the system honestly

A 5-minute validation protocol:

1. Calibrate baseline with the room empty.
2. Subject sits, holds their breath for 15 s. Resp display should show no value (low confidence) during the breath-hold and resume when normal breathing returns.
3. Subject paces breathing at 6 BPM (10 s in / 10 s out) with a metronome. Display should land at ~6 BPM with HIGH confidence.
4. Subject paces at 20 BPM. Display should land at ~20 BPM.
5. Subject walks across the link. `Stillness gate active — vital readings suppressed` banner should appear immediately; both BPM cards should clear.
6. Polar H10 ground truth (optional). Strap on the H10, sit still, compare phone-app HR against the displayed HR-band BPM. Expect significant disagreement at 2 m on this hardware; this is honest and expected.

If steps 2–5 do not behave as described, the physics setup is wrong, not the software.

## What NOT to claim

- Do not call the HR-band number "heart rate" in any communication outside this system. It is the strongest periodic motion in that band.
- Do not derive HRV / SDNN / RMSSD from this output. The earlier HRV-in-ms card was a pure heuristic and has been removed.
- Do not derive emotional state, stress level, or affect from these numbers. The earlier Stress / affect card is removed for the same reason.
- Do not claim through-wall sensing.
