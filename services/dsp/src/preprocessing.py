"""CSI preprocessing: I/Q decoding, amplitude/phase extraction, subcarrier hygiene.

Two parallel APIs live here:

- The original list-based helpers (``raw_iq_to_complex``, ``amplitudes``,
  ``phases``, ``unwrap_phase``) are kept because tests and other callers
  depend on them.

- New NumPy-vectorized helpers (``frames_to_amplitude_matrix``,
  ``frames_to_phase_matrix``, ``drop_edge_subcarriers``,
  ``select_subcarriers_by_variance``) are used by the rewritten feature
  extractor, the biorhythm estimator, and the calibration module. They do
  the same job at orders of magnitude better throughput and let us reason
  about subcarrier shapes as proper matrices.
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def raw_iq_to_complex(raw_iq_int8: list[int]) -> list[complex]:
    pairs = zip(raw_iq_int8[0::2], raw_iq_int8[1::2], strict=False)
    return [complex(i, q) for i, q in pairs]


def amplitudes(values: list[complex]) -> list[float]:
    return [abs(value) for value in values]


def phases(values: list[complex]) -> list[float]:
    return [math.atan2(value.imag, value.real) for value in values]


def unwrap_phase(values: list[float]) -> list[float]:
    if not values:
        return []
    unwrapped = [values[0]]
    offset = 0.0
    previous = values[0]
    for value in values[1:]:
        delta = value - previous
        if delta > math.pi:
            offset -= math.tau
        elif delta < -math.pi:
            offset += math.tau
        unwrapped.append(value + offset)
        previous = value
    return unwrapped


def iq_array_to_amplitude(raw_iq_int8: Sequence[int]) -> np.ndarray:
    """Vectorized: signed int8 I/Q stream -> 1D float amplitude per subcarrier.

    Returns an empty array when the input has fewer than two samples.
    """
    if len(raw_iq_int8) < 2:
        return np.zeros(0, dtype=np.float64)
    arr = np.asarray(raw_iq_int8, dtype=np.float64)
    n = arr.size - (arr.size % 2)
    arr = arr[:n].reshape(-1, 2)
    return np.hypot(arr[:, 0], arr[:, 1])


def iq_array_to_phase(raw_iq_int8: Sequence[int]) -> np.ndarray:
    if len(raw_iq_int8) < 2:
        return np.zeros(0, dtype=np.float64)
    arr = np.asarray(raw_iq_int8, dtype=np.float64)
    n = arr.size - (arr.size % 2)
    arr = arr[:n].reshape(-1, 2)
    return np.arctan2(arr[:, 1], arr[:, 0])


def frames_to_amplitude_matrix(frames: list) -> np.ndarray:
    """Stack per-frame amplitude vectors into a (T, S) matrix.

    Uses the smallest subcarrier count seen across the window so the result is
    rectangular even if the firmware truncates packets unevenly.
    """
    if not frames:
        return np.zeros((0, 0), dtype=np.float64)
    rows = [iq_array_to_amplitude(frame.raw_iq_int8) for frame in frames]
    rows = [row for row in rows if row.size > 0]
    if not rows:
        return np.zeros((0, 0), dtype=np.float64)
    width = min(row.size for row in rows)
    if width == 0:
        return np.zeros((0, 0), dtype=np.float64)
    return np.stack([row[:width] for row in rows], axis=0)


def frames_to_phase_matrix(frames: list) -> np.ndarray:
    if not frames:
        return np.zeros((0, 0), dtype=np.float64)
    rows = [iq_array_to_phase(frame.raw_iq_int8) for frame in frames]
    rows = [row for row in rows if row.size > 0]
    if not rows:
        return np.zeros((0, 0), dtype=np.float64)
    width = min(row.size for row in rows)
    if width == 0:
        return np.zeros((0, 0), dtype=np.float64)
    return np.unwrap(np.stack([row[:width] for row in rows], axis=0), axis=0)


def drop_edge_subcarriers(matrix: np.ndarray, *, edge_fraction: float = 0.06) -> tuple[np.ndarray, np.ndarray]:
    """Drop the leftmost and rightmost ``edge_fraction`` of subcarriers.

    ESP32-S3 LLTF/HTLTF blocks include null-DC and edge guard subcarriers that
    are noisy by design. Returns ``(matrix_trimmed, kept_indices)``.
    """
    if matrix.ndim != 2 or matrix.shape[1] == 0:
        return matrix, np.arange(matrix.shape[1] if matrix.ndim == 2 else 0, dtype=np.int64)
    width = matrix.shape[1]
    drop = max(0, int(round(width * float(edge_fraction))))
    if 2 * drop >= width:
        return matrix, np.arange(width, dtype=np.int64)
    kept = np.arange(drop, width - drop, dtype=np.int64)
    return matrix[:, kept], kept


def select_subcarriers_by_variance(matrix: np.ndarray, *, top_k: int = 8) -> np.ndarray:
    """Return the indices of the top-K subcarriers ranked by std across time."""
    if matrix.ndim != 2 or matrix.shape[1] == 0:
        return np.array([], dtype=np.int64)
    std = matrix.std(axis=0)
    k = max(1, min(int(top_k), std.size))
    order = np.argsort(std)[::-1]
    return np.sort(order[:k])


def remove_linear_phase_per_frame(phase_matrix: np.ndarray) -> np.ndarray:
    """Strip per-frame linear phase (CFO + STO) from a (T, S) phase matrix.

    Each row gets a least-squares line ``a * k + b`` fitted across the
    subcarrier index ``k`` and subtracted, leaving the per-subcarrier phase
    deviation. This is the standard PhaseFi-style detrend that turns raw
    ESP32 phase output into something usable as a motion signal.

    Returns a matrix of the same shape; if the input has fewer than two
    subcarriers the matrix is returned unchanged.
    """
    if phase_matrix.ndim != 2 or phase_matrix.shape[1] < 2:
        return phase_matrix
    k = np.arange(phase_matrix.shape[1], dtype=np.float64)
    out = np.empty_like(phase_matrix, dtype=np.float64)
    for t in range(phase_matrix.shape[0]):
        row = phase_matrix[t].astype(np.float64)
        # np.polyfit handles NaN-free, length-N input cheaply for small N.
        slope, intercept = np.polyfit(k, row, 1)
        out[t] = row - (slope * k + intercept)
    return out
