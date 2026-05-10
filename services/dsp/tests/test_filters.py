"""Smoke tests for the conditioning filters that sit between the collector and
the feature extractor. Each test verifies a single, well-defined property that
real CSI data exercises in production."""
from __future__ import annotations

import numpy as np

from services.dsp.src.filters import (
    butter_filter_1d,
    butter_filter_columns,
    detrend_columns,
    hampel_filter_1d,
    hampel_filter_columns,
    linear_detrend,
    resample_uniform,
    to_db,
)


def test_hampel_replaces_single_outlier_with_local_median() -> None:
    series = np.array([10.0] * 20, dtype=np.float64)
    series[10] = 1000.0
    out = hampel_filter_1d(series, window=5, n_sigmas=3.0)
    assert abs(out[10] - 10.0) < 1e-6
    # Surrounding samples are untouched.
    assert np.all(np.abs(out[:10] - 10.0) < 1e-6)
    assert np.all(np.abs(out[11:] - 10.0) < 1e-6)


def test_hampel_columns_runs_per_subcarrier() -> None:
    matrix = np.tile(np.arange(20, dtype=np.float64), (4, 1)).T  # (20, 4)
    matrix[5, 2] = 9999.0
    out = hampel_filter_columns(matrix, window=5)
    assert out[5, 2] != 9999.0
    # Column 0 unchanged.
    assert np.allclose(out[:, 0], matrix[:, 0])


def test_linear_detrend_removes_a_constant_slope() -> None:
    n = 100
    x = np.arange(n, dtype=np.float64)
    series = 2.0 * x + 5.0
    out = linear_detrend(series)
    assert abs(out.mean()) < 1e-9
    assert abs(out.max() - out.min()) < 1e-9


def test_detrend_columns_zero_mean_per_column() -> None:
    n = 80
    x = np.arange(n, dtype=np.float64)
    matrix = np.stack([2 * x + 1, -3 * x + 7, x * 0.5 - 2], axis=1)
    out = detrend_columns(matrix)
    for col in range(out.shape[1]):
        assert abs(out[:, col].mean()) < 1e-9


def test_butter_bandpass_attenuates_dc_and_passes_resp_band() -> None:
    fs = 20.0
    duration = 30.0
    t = np.arange(0, duration, 1.0 / fs)
    dc = 5.0 * np.ones_like(t)
    resp = np.sin(2 * np.pi * 0.25 * t)  # 15 BPM
    series = dc + resp
    filtered = butter_filter_1d(series, sample_rate_hz=fs, low_hz=0.05, high_hz=3.0, order=3)
    # Mean of a clean DC-removed signal should be close to zero.
    assert abs(filtered.mean()) < 0.1
    # Amplitude of the 0.25 Hz tone should be preserved (within a few %).
    assert filtered.std() > 0.6


def test_butter_columns_handles_short_series_without_crashing() -> None:
    fs = 20.0
    matrix = np.random.RandomState(1).randn(8, 3)
    out = butter_filter_columns(matrix, sample_rate_hz=fs, low_hz=0.1, high_hz=3.0)
    assert out.shape == matrix.shape


def test_to_db_floor_prevents_log_zero() -> None:
    out = to_db(np.array([0.0, 1.0, 10.0]))
    assert np.all(np.isfinite(out))
    assert abs(out[1] - 0.0) < 1e-6
    assert abs(out[2] - 20.0) < 1e-6


def test_resample_uniform_preserves_endpoints() -> None:
    ts_ns = np.array([0, 50_000_000, 110_000_000, 160_000_000], dtype=np.int64)
    values = np.array([1.0, 2.0, 3.0, 4.0])
    grid_ts, grid_v = resample_uniform(ts_ns, values, target_rate_hz=20.0)
    assert grid_ts[0] == ts_ns[0]
    assert grid_ts[-1] == ts_ns[-1]
    assert grid_v[0] == values[0]
    assert abs(grid_v[-1] - values[-1]) < 1e-6


def test_resample_uniform_handles_too_few_samples() -> None:
    ts_ns = np.array([0], dtype=np.int64)
    values = np.array([1.0])
    grid_ts, grid_v = resample_uniform(ts_ns, values, target_rate_hz=20.0)
    assert grid_ts.size == 1
    assert grid_v.size == 1
