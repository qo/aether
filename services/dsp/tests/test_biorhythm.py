"""Synthetic-signal validation for BiorhythmEstimator.

We feed it a sinusoid embedded in DC + drift + noise and confirm the FFT
recovers the right peak inside the breathing or HR band, with confidence > 0.5.
"""
from __future__ import annotations

import math
import random

from aether_protocol import RawCsiFrame, SourceMode
from services.dsp.src.biorhythm import BiorhythmEstimator


def _synthesize_frame(*, ts_ns: int, base_amp: float, seq: int, session_id: str) -> RawCsiFrame:
    iq: list[int] = []
    # 32 subcarriers, two int8 per subcarrier (I,Q). All carriers carry the same
    # base amplitude so the per-frame mean amplitude == base_amp (Â±1 from int rounding).
    for _ in range(32):
        side = base_amp / math.sqrt(2)
        clamped = max(-127, min(127, int(round(side))))
        iq.append(clamped)
        iq.append(clamped)
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
        payload_len=len(iq),
        raw_iq_int8=iq,
        source_mode=SourceMode.REPLAY,
    )


def _drive(estimator: BiorhythmEstimator, *, freq_hz: float, sample_rate: float, seconds: float) -> None:
    rng = random.Random(7)
    n = int(sample_rate * seconds)
    base = 70.0
    swing = 25.0
    session_id = "synthetic"
    period_ns = int(1_000_000_000 / sample_rate)
    for k in range(n):
        ts_ns = k * period_ns
        # Sine + small Gaussian noise + slow linear drift (estimator detrends).
        sine = math.sin(2 * math.pi * freq_hz * k / sample_rate)
        drift = 0.4 * (k / n)
        noise = rng.gauss(0, 0.4)
        amp = base + swing * sine + drift + noise
        frame = _synthesize_frame(ts_ns=ts_ns, base_amp=amp, seq=k, session_id=session_id)
        estimator.update(frame)


def test_recovers_breathing_peak_at_15_bpm():
    estimator = BiorhythmEstimator()
    _drive(estimator, freq_hz=15 / 60, sample_rate=20.0, seconds=20.0)
    reading = estimator.latest()
    assert reading.respiration_bpm is not None
    assert abs(reading.respiration_bpm - 15.0) < 1.5
    assert reading.respiration_confidence is not None
    assert reading.respiration_confidence > 0.3


def test_recovers_periodic_peak_at_72_bpm_in_heart_band():
    estimator = BiorhythmEstimator()
    _drive(estimator, freq_hz=72 / 60, sample_rate=20.0, seconds=20.0)
    reading = estimator.latest()
    assert reading.heart_rate_proxy_bpm is not None
    assert 60 <= reading.heart_rate_proxy_bpm <= 84
    assert reading.heart_rate_proxy_confidence is not None
    assert reading.heart_rate_proxy_confidence > 0.3


def test_low_confidence_on_pure_noise():
    estimator = BiorhythmEstimator()
    rng = random.Random(13)
    sample_rate = 20.0
    seconds = 20.0
    period_ns = int(1_000_000_000 / sample_rate)
    n = int(sample_rate * seconds)
    for k in range(n):
        ts_ns = k * period_ns
        amp = 70.0 + rng.gauss(0, 5)
        frame = _synthesize_frame(ts_ns=ts_ns, base_amp=amp, seq=k, session_id="noise")
        estimator.update(frame)
    reading = estimator.latest()
    # Pure noise should not yield a strongly prominent peak in either band.
    if reading.respiration_confidence is not None:
        assert reading.respiration_confidence < 0.6
    if reading.heart_rate_proxy_confidence is not None:
        assert reading.heart_rate_proxy_confidence < 0.6


def test_returns_empty_below_min_samples():
    estimator = BiorhythmEstimator()
    sample_rate = 20.0
    period_ns = int(1_000_000_000 / sample_rate)
    for k in range(8):
        frame = _synthesize_frame(ts_ns=k * period_ns, base_amp=70.0, seq=k, session_id="few")
        estimator.update(frame)
    reading = estimator.latest()
    assert reading.respiration_bpm is None
    assert reading.heart_rate_proxy_bpm is None
