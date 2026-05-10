"""CSI-ratio path for vital-sign extraction on COTS Wi-Fi hardware.

The single biggest barrier to seeing breathing in raw CSI amplitude at >1 m
on ESP32-S3 PCB antennas is that each frame's complex CSI is corrupted by:

- packet detection delay (random sub-microsecond timing offset),
- carrier frequency offset (CFO) between TX and RX oscillators,
- sampling time offset (STO),
- and gain control re-scaling.

These corruptions produce a per-frame complex multiplicative term that masks
the actual sub-mm path-length changes from breathing or heart motion.

The CSI-ratio trick (Wang et al., SenSys 2017; Zeng et al., CSI-quotient)
divides the complex CSI of one subcarrier by an adjacent subcarrier's CSI.
Since the per-frame CFO/STO terms are nearly identical for adjacent
subcarriers, they cancel in the ratio, leaving a much cleaner signal whose
phase and magnitude reflect the geometry of the propagation paths.

This module gives ``derive_window`` and ``BiorhythmEstimator`` an alternative
1-D scalar series that is far more sensitive to small body motion than the
mean-amplitude path. It is research-level DSP, not a magic accuracy fix; we
still depend on the body being in the LOS path or the first Fresnel zone.
"""
from __future__ import annotations

from collections.abc import Sequence

import numpy as np


def iq_array_to_complex(raw_iq_int8: Sequence[int]) -> np.ndarray:
    """Vectorised: signed int8 I/Q stream -> 1D complex CSI per subcarrier."""
    if len(raw_iq_int8) < 2:
        return np.zeros(0, dtype=np.complex128)
    arr = np.asarray(raw_iq_int8, dtype=np.float64)
    n = arr.size - (arr.size % 2)
    arr = arr[:n].reshape(-1, 2)
    return arr[:, 0] + 1j * arr[:, 1]


def frames_to_complex_matrix(frames: list) -> np.ndarray:
    """Stack per-frame complex CSI vectors into a (T, S) matrix."""
    if not frames:
        return np.zeros((0, 0), dtype=np.complex128)
    rows = [iq_array_to_complex(frame.raw_iq_int8) for frame in frames]
    rows = [row for row in rows if row.size > 0]
    if not rows:
        return np.zeros((0, 0), dtype=np.complex128)
    width = min(row.size for row in rows)
    if width == 0:
        return np.zeros((0, 0), dtype=np.complex128)
    return np.stack([row[:width] for row in rows], axis=0)


def csi_ratio_pairs(complex_matrix: np.ndarray, *, stride: int = 1) -> np.ndarray:
    """Compute the complex ratio of subcarrier k and k+stride at every frame.

    Returns a (T, S - stride) matrix of complex ratios. The magnitude of each
    column is far more stable across frames than raw |c_k|, because the
    common-mode CFO/STO terms cancel in the division.
    """
    if complex_matrix.ndim != 2 or complex_matrix.shape[1] <= stride:
        return np.zeros((complex_matrix.shape[0], 0), dtype=np.complex128)
    numer = complex_matrix[:, :-stride]
    denom = complex_matrix[:, stride:]
    safe_denom = np.where(np.abs(denom) < 1e-9, 1e-9 + 0j, denom)
    return numer / safe_denom


def csi_ratio_magnitude(complex_matrix: np.ndarray, *, stride: int = 1) -> np.ndarray:
    """Convenience: |ratio| matrix as a real (T, S - stride) array."""
    ratios = csi_ratio_pairs(complex_matrix, stride=stride)
    return np.abs(ratios).astype(np.float64)


def csi_ratio_phase(complex_matrix: np.ndarray, *, stride: int = 1) -> np.ndarray:
    """Phase of the CSI ratio, unwrapped along the time axis.

    For each subcarrier-pair k the time series is the *phase* of
    csi[t, k] / csi[t, k+stride]. The CFO/STO common-mode term cancels in
    the ratio (same as for magnitude), but the phase carries Doppler-like
    information about how the propagation path length is changing — body
    motion towards/away from the link causes a smooth phase drift, which
    on real hardware often gives a higher-SNR breathing signal than the
    magnitude path.

    Returns (T, S - stride) real array of unwrapped phases. Empty matrix
    on degenerate input.
    """
    ratios = csi_ratio_pairs(complex_matrix, stride=stride)
    if ratios.ndim != 2 or ratios.shape[1] == 0 or ratios.shape[0] == 0:
        return np.zeros((ratios.shape[0] if ratios.ndim == 2 else 0, 0), dtype=np.float64)
    angle = np.angle(ratios).astype(np.float64)
    # Unwrap along the time axis (axis 0) so a 2π discontinuity between
    # two consecutive frames doesn't masquerade as a real motion event.
    return np.unwrap(angle, axis=0)


def best_ratio_subcarriers(
    ratio_magnitude: np.ndarray,
    *,
    breathing_band_hz: tuple[float, float] = (0.10, 0.50),
    sample_rate_hz: float,
    top_k: int = 6,
) -> np.ndarray:
    """Pick subcarrier-pair indices whose |ratio| time series has the most
    energy in the breathing band, relative to total energy across all bands.

    This is meaningfully better than max-variance selection because pure noise
    distributes its energy uniformly while breathing concentrates it in a
    narrow band. Returns indices sorted ascending.
    """
    if ratio_magnitude.ndim != 2 or ratio_magnitude.shape[1] == 0:
        return np.array([], dtype=np.int64)
    n = ratio_magnitude.shape[0]
    if n < 16 or sample_rate_hz <= 0:
        # Fall back to variance ranking if the window is too short.
        std = ratio_magnitude.std(axis=0)
        if not np.any(std > 0):
            return np.array([0], dtype=np.int64)
        k = max(1, min(int(top_k), std.size))
        return np.sort(np.argsort(std)[-k:])

    centred = ratio_magnitude - ratio_magnitude.mean(axis=0, keepdims=True)
    spectrum = np.fft.rfft(centred, axis=0)
    magnitudes = np.abs(spectrum)
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate_hz)
    band_mask = (freqs >= breathing_band_hz[0]) & (freqs <= breathing_band_hz[1])
    if not np.any(band_mask):
        std = ratio_magnitude.std(axis=0)
        k = max(1, min(int(top_k), std.size))
        return np.sort(np.argsort(std)[-k:])
    band_energy = (magnitudes[band_mask] ** 2).sum(axis=0)
    total_energy = (magnitudes ** 2).sum(axis=0) + 1e-12
    ratio = band_energy / total_energy
    if not np.any(ratio > 0):
        std = ratio_magnitude.std(axis=0)
        k = max(1, min(int(top_k), std.size))
        return np.sort(np.argsort(std)[-k:])
    k = max(1, min(int(top_k), ratio.size))
    return np.sort(np.argsort(ratio)[-k:])
