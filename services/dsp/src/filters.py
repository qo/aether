"""Signal-conditioning filters used before motion / occupancy / biorhythm extraction.

These are the operations that turn raw ESP32-S3 CSI amplitude streams (which are
dominated by DC, environmental drift, impulsive noise from packet loss, and
hardware nonlinearity) into something where small body-induced perturbations are
visible. They are written so that:

- Hampel removes single-frame spikes from `first_word_invalid` packets and
  CSI quantization glitches without smearing real motion onto neighbours.
- Butterworth bandpass at 0.05-5 Hz keeps respiration / body-motion frequencies
  and rejects DC drift and HF measurement noise.
- Linear detrend cleans up slow scene drift (people walking past, AGC creep).
- Uniform resampling lets the FFT-based biorhythm estimator assume a regular
  sample grid even when serial jitter spreads inter-arrival times.

All functions take and return numpy arrays. They never silently drop samples.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from scipy.signal import butter, filtfilt


def hampel_filter_1d(
    values: np.ndarray,
    *,
    window: int = 7,
    n_sigmas: float = 3.0,
) -> np.ndarray:
    """Replace outliers in a 1D series with the local median.

    Window is the half-window length on each side. We use a robust MAD-based
    estimate of the local scale, so this resists impulsive CSI glitches
    (e.g. one bad packet flipping a subcarrier amplitude by 10x) without
    blurring genuine motion edges.

    When the local block is degenerate (most values identical -> MAD=0) we
    fall back to the standard deviation of the block as the scale estimate,
    so a single spike still gets caught.
    """
    if values.ndim != 1:
        raise ValueError("hampel_filter_1d expects a 1D array")
    n = values.size
    if n == 0:
        return values
    out = values.astype(np.float64, copy=True)
    half = max(1, int(window))
    k = 1.4826  # MAD -> sigma scaling for normal data
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        block = out[lo:hi]
        median = float(np.median(block))
        mad = float(np.median(np.abs(block - median)))
        sigma = k * mad
        if sigma == 0:
            # Degenerate block: most samples identical. Fall back to std so a
            # lone spike against a flat baseline is still caught.
            sigma = float(np.std(block))
        if sigma > 0 and abs(out[i] - median) > n_sigmas * sigma:
            out[i] = median
    return out


def hampel_filter_columns(matrix: np.ndarray, *, window: int = 7, n_sigmas: float = 3.0) -> np.ndarray:
    """Apply the Hampel filter independently to each column (each subcarrier)."""
    if matrix.ndim != 2:
        raise ValueError("hampel_filter_columns expects a 2D array (time, subcarrier)")
    out = matrix.astype(np.float64, copy=True)
    for col in range(out.shape[1]):
        out[:, col] = hampel_filter_1d(out[:, col], window=window, n_sigmas=n_sigmas)
    return out


def linear_detrend(values: np.ndarray) -> np.ndarray:
    """Subtract a least-squares linear trend from a 1D series."""
    n = values.size
    if n < 2:
        return values - float(values.mean()) if n else values
    x = np.arange(n, dtype=np.float64)
    slope, intercept = np.polyfit(x, values.astype(np.float64), 1)
    return values - (slope * x + intercept)


def detrend_columns(matrix: np.ndarray) -> np.ndarray:
    """Detrend each column independently."""
    out = matrix.astype(np.float64, copy=True)
    for col in range(out.shape[1]):
        out[:, col] = linear_detrend(out[:, col])
    return out


@lru_cache(maxsize=64)
def _design_butter_cached(
    sample_rate_key: float,
    low_key: float | None,
    high_key: float | None,
    order: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Internal cache. Inputs must already be rounded so equal calls hit."""
    nyq = 0.5 * sample_rate_key
    low_hz = low_key
    high_hz = high_key
    if high_hz is not None and high_hz >= nyq:
        high_hz = nyq * 0.999
    if low_hz is not None and high_hz is not None:
        b, a = butter(order, [low_hz / nyq, high_hz / nyq], btype="band")
    elif low_hz is not None:
        b, a = butter(order, low_hz / nyq, btype="highpass")
    elif high_hz is not None:
        b, a = butter(order, high_hz / nyq, btype="lowpass")
    else:
        raise ValueError("at least one of low_hz or high_hz must be set")
    return b, a


def _design_butter(sample_rate_hz: float, low_hz: float | None, high_hz: float | None, order: int) -> tuple:
    """Design a Butterworth filter with results cached per (rate, band, order).

    The DSP loop calls this 2-3 times per derived window with the same
    parameters every call (sample rate adopts the observed value once and
    stays fixed; band edges and order are constants). Caching the design
    skips ~50-200 µs of polynomial root-finding per invocation, which adds
    up over a 20 Hz cadence.

    Keys are rounded so floating-point jitter in observed_rate doesn't
    blow the cache: sample rate to 0.1 Hz, band edges to 0.01 Hz.
    """
    rate_key = round(float(sample_rate_hz), 1)
    if low_hz is not None and low_hz <= 0:
        low_hz = None
    low_key = round(float(low_hz), 4) if low_hz is not None else None
    high_key = round(float(high_hz), 4) if high_hz is not None else None
    return _design_butter_cached(rate_key, low_key, high_key, int(order))


def butter_filter_1d(
    values: np.ndarray,
    *,
    sample_rate_hz: float,
    low_hz: float | None = None,
    high_hz: float | None = None,
    order: int = 3,
) -> np.ndarray:
    """Apply a zero-phase Butterworth filter to a 1D series.

    Returns the input unchanged if the series is too short for filtfilt's
    default padlen (which is 3 * len(b) for a Butterworth of order N where
    len(b) = 2*N + 1). Callers should treat the early output as warm-up.
    """
    if sample_rate_hz <= 0:
        return values.astype(np.float64, copy=True)
    # scipy.filtfilt's default padlen is 3 * max(len(a), len(b)) which is
    # 3 * (2*order + 1) for Butterworth bandpass, plus a strict-greater check.
    min_samples = 3 * (2 * order + 1) + 1
    if values.size < min_samples:
        return values.astype(np.float64, copy=True)
    b, a = _design_butter(sample_rate_hz, low_hz, high_hz, order)
    return filtfilt(b, a, values.astype(np.float64))


def butter_filter_columns(
    matrix: np.ndarray,
    *,
    sample_rate_hz: float,
    low_hz: float | None = None,
    high_hz: float | None = None,
    order: int = 3,
) -> np.ndarray:
    """Apply the same Butterworth filter to each column independently."""
    out = matrix.astype(np.float64, copy=True)
    for col in range(out.shape[1]):
        out[:, col] = butter_filter_1d(
            out[:, col],
            sample_rate_hz=sample_rate_hz,
            low_hz=low_hz,
            high_hz=high_hz,
            order=order,
        )
    return out


def to_db(values: np.ndarray, *, floor: float = 1e-6) -> np.ndarray:
    """Convert linear amplitudes to dB. Adds a small floor to avoid log(0)."""
    safe = np.maximum(values.astype(np.float64), floor)
    return 20.0 * np.log10(safe)


def resample_uniform(
    timestamps_ns: np.ndarray,
    values: np.ndarray,
    *,
    target_rate_hz: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Resample an irregularly-sampled series onto a uniform grid via linear interp.

    Returns (uniform_ts_ns, uniform_values). If the series is shorter than two
    samples it is returned unchanged.
    """
    if timestamps_ns.size < 2 or values.size < 2:
        return timestamps_ns, values
    start = int(timestamps_ns[0])
    end = int(timestamps_ns[-1])
    duration_s = (end - start) / 1_000_000_000
    if duration_s <= 0 or target_rate_hz <= 0:
        return timestamps_ns, values
    n_target = max(2, int(round(duration_s * target_rate_hz)))
    grid_ns = np.linspace(start, end, n_target).astype(np.int64)
    grid_values = np.interp(
        grid_ns.astype(np.float64),
        timestamps_ns.astype(np.float64),
        values.astype(np.float64),
    )
    return grid_ns, grid_values
