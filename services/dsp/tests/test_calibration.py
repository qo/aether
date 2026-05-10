"""Tests for the empty-room baseline calibrator."""
from __future__ import annotations

import numpy as np

from services.dsp.src.calibration import BaselineCalibrator


def test_begin_then_feed_completes_after_target_duration() -> None:
    cal = BaselineCalibrator()
    cal.begin(duration_seconds=1.0)
    period_ns = 50_000_000  # 20 Hz
    n = 40  # 2 s of frames
    completed = False
    for k in range(n):
        completed = cal.feed(np.array([10.0, 11.0, 12.0]), ts_host_ns=k * period_ns) or completed
    assert cal.is_calibrated
    assert completed
    assert not cal.is_calibrating


def test_subtract_baseline_returns_residual() -> None:
    cal = BaselineCalibrator()
    cal.begin(duration_seconds=0.5)
    period_ns = 50_000_000
    for k in range(40):
        cal.feed(np.array([10.0, 20.0, 30.0]), ts_host_ns=k * period_ns)
    matrix = np.array([[12.0, 22.0, 33.0], [11.0, 21.0, 31.0]])
    residual = cal.subtract_baseline(matrix)
    # Per-column delta from baseline mean of (10, 20, 30).
    expected = np.array([[2.0, 2.0, 3.0], [1.0, 1.0, 1.0]])
    assert np.allclose(residual, expected, atol=1e-6)


def test_snr_weights_downweight_noisy_subcarriers() -> None:
    cal = BaselineCalibrator()
    cal.begin(duration_seconds=0.5)
    period_ns = 50_000_000
    rng = np.random.RandomState(7)
    # Two subcarriers: one quiet (std ~0.5), one noisy (std ~5).
    for k in range(80):
        sample = np.array([10.0 + rng.normal(0, 0.5), 30.0 + rng.normal(0, 5.0)])
        cal.feed(sample, ts_host_ns=k * period_ns)
    weights = cal.snr_weights()
    assert weights is not None
    assert weights[0] > weights[1]
    assert abs(weights.sum() - 1.0) < 1e-6


def test_select_responsive_subcarriers_uses_baseline_normalised_score() -> None:
    cal = BaselineCalibrator()
    cal.begin(duration_seconds=0.5)
    period_ns = 50_000_000
    rng = np.random.RandomState(3)
    for k in range(80):
        sample = np.array(
            [10.0 + rng.normal(0, 0.2), 20.0 + rng.normal(0, 5.0), 30.0 + rng.normal(0, 0.3)]
        )
        cal.feed(sample, ts_host_ns=k * period_ns)
    # Now pretend a person perturbs subcarrier 0 strongly.
    amp_std_now = np.array([4.0, 6.0, 0.5])
    chosen = cal.select_responsive_subcarriers(amp_std_now, top_k=2)
    assert 0 in chosen.tolist()


def test_status_shape_is_serializable() -> None:
    cal = BaselineCalibrator()
    status = cal.status()
    assert {"is_calibrated", "is_calibrating", "frames_observed", "subcarrier_count"}.issubset(status)
