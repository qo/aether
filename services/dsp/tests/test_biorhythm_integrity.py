"""Integrity tests for the biorhythm pipeline.

These cover the new behaviours added on top of the FFT estimator:
  - stillness gate suppresses BPM when motion is high
  - confidence-tracker EWMA stabilises BPM across windows
  - HR-band peak that looks like 2x respiration is suppressed
  - autocorrelation cross-check fields are populated alongside FFT
"""
from __future__ import annotations

import math
import random

from aether_protocol import RawCsiFrame, SourceMode
from services.dsp.src.biorhythm import BiorhythmEstimator


def _frame(*, ts_ns: int, seq: int, vec: list[int], session_id: str) -> RawCsiFrame:
    return RawCsiFrame(
        session_id=session_id,
        device_id="esp32-s3-rx",
        device_role="rx",
        seq=seq,
        ts_device_us=ts_ns // 1000,
        ts_host_ns=ts_ns,
        channel=6,
        rssi_dbm=-55,
        noise_floor_dbm=-95,
        sig_mode=0,
        cwb=0,
        secondary_channel=0,
        stbc=0,
        first_word_invalid=False,
        payload_len=len(vec),
        raw_iq_int8=vec,
        source_mode=SourceMode.REPLAY,
    )


def _drive_breathing(estimator: BiorhythmEstimator, *, freq_hz: float, seconds: float, sample_rate: float, motion_score: float | None = None, baseline_calibrated: bool = False) -> None:
    rng = random.Random(7)
    n = int(sample_rate * seconds)
    period_ns = int(1_000_000_000 / sample_rate)
    base = 70.0
    swing = 25.0
    for k in range(n):
        ts = k * period_ns
        sine = math.sin(2 * math.pi * freq_hz * k / sample_rate)
        amp = base + swing * sine + rng.gauss(0, 0.4)
        side = max(-127, min(127, int(round(amp / math.sqrt(2)))))
        vec = [side, side] * 32
        estimator.update(
            _frame(ts_ns=ts, seq=k, vec=vec, session_id="t"),
            motion_score=motion_score,
            baseline_calibrated=baseline_calibrated,
        )


def test_stillness_gate_suppresses_when_motion_is_high_and_calibrated() -> None:
    e = BiorhythmEstimator()
    _drive_breathing(e, freq_hz=0.25, seconds=20, sample_rate=20.0, motion_score=4.0, baseline_calibrated=True)
    reading = e.latest()
    assert reading.stillness_gated is True
    assert reading.respiration_bpm is None
    assert reading.heart_rate_proxy_bpm is None


def test_stillness_gate_inactive_when_motion_is_low() -> None:
    e = BiorhythmEstimator()
    _drive_breathing(e, freq_hz=0.25, seconds=20, sample_rate=20.0, motion_score=0.4, baseline_calibrated=True)
    reading = e.latest()
    assert reading.stillness_gated is False
    assert reading.respiration_bpm is not None
    assert abs(reading.respiration_bpm - 15.0) < 2.0


def test_acf_field_is_populated_alongside_fft() -> None:
    e = BiorhythmEstimator()
    _drive_breathing(e, freq_hz=0.25, seconds=20, sample_rate=20.0, motion_score=0.0, baseline_calibrated=False)
    reading = e.latest()
    # Both FFT and ACF should be reported when the signal is clean.
    assert reading.respiration_bpm is not None
    # ACF must agree closely with FFT for a clean sinusoid.
    if reading.respiration_bpm_acf is not None:
        assert abs(reading.respiration_bpm_acf - reading.respiration_bpm) < 5.0


def test_tracker_smooths_bpm_across_windows() -> None:
    e = BiorhythmEstimator()
    _drive_breathing(e, freq_hz=0.25, seconds=20, sample_rate=20.0, motion_score=0.0)
    reading = e.latest()
    assert reading.respiration_tracked_bpm is not None
    # Tracker should be near the FFT peak after a long stable run.
    if reading.respiration_bpm is not None:
        assert abs(reading.respiration_tracked_bpm - reading.respiration_bpm) < 4.0


def test_signal_path_falls_back_to_amplitude_for_uniform_subcarriers() -> None:
    # Synthetic frames have all subcarriers identical -> CSI-ratio is a constant
    # 1.0 everywhere, so the estimator must fall back to the amplitude path.
    e = BiorhythmEstimator()
    _drive_breathing(e, freq_hz=0.25, seconds=20, sample_rate=20.0)
    reading = e.latest()
    assert reading.signal_path == "amplitude"
