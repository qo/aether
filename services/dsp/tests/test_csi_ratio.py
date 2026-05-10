"""Tests for the CSI-ratio module."""
from __future__ import annotations

import numpy as np

from services.dsp.src.csi_ratio import (
    best_ratio_subcarriers,
    csi_ratio_magnitude,
    csi_ratio_pairs,
    iq_array_to_complex,
    frames_to_complex_matrix,
)


def test_iq_array_to_complex_pairs_int8() -> None:
    arr = iq_array_to_complex([1, 2, -3, 4])
    assert arr.shape == (2,)
    assert arr[0] == complex(1, 2)
    assert arr[1] == complex(-3, 4)


def test_csi_ratio_cancels_common_phase_factor() -> None:
    # Adjacent subcarriers carrying the same body-modulated signal but a
    # different per-frame phase factor should produce a *constant* ratio.
    n_frames = 64
    n_sub = 8
    rng = np.random.RandomState(0)
    base = np.linspace(0.5, 1.5, n_sub)  # different absolute amplitudes
    matrix = np.zeros((n_frames, n_sub), dtype=np.complex128)
    for f in range(n_frames):
        per_frame_phase = np.exp(1j * rng.uniform(-1.0, 1.0))
        for s in range(n_sub):
            matrix[f, s] = base[s] * per_frame_phase
    ratios = csi_ratio_pairs(matrix, stride=1)
    # The ratio of two columns differing only by a constant should be constant
    # in time per pair, regardless of the per-frame phase term.
    for col in range(ratios.shape[1]):
        assert np.std(np.abs(ratios[:, col])) < 1e-9


def test_csi_ratio_magnitude_shape() -> None:
    matrix = np.ones((10, 5), dtype=np.complex128)
    rm = csi_ratio_magnitude(matrix, stride=1)
    assert rm.shape == (10, 4)
    assert np.allclose(rm, 1.0)


def test_best_ratio_subcarriers_picks_breathing_band_concentrated() -> None:
    # Build a (T, P) matrix where one column is a clean 0.25 Hz tone and the
    # rest are white noise. The best_ratio_subcarriers selector should pick it.
    fs = 20.0
    n = 200
    t = np.arange(n) / fs
    rng = np.random.RandomState(11)
    matrix = rng.normal(0, 1.0, size=(n, 6))
    matrix[:, 3] = 0.6 * np.sin(2 * np.pi * 0.25 * t) + 0.05 * rng.normal(0, 1.0, size=n)
    chosen = best_ratio_subcarriers(matrix, sample_rate_hz=fs, top_k=1)
    assert chosen.tolist() == [3]


def test_frames_to_complex_matrix_handles_mixed_widths() -> None:
    class _F:
        def __init__(self, iq: list[int]) -> None:
            self.raw_iq_int8 = iq

    frames = [_F([1, 2, 3, 4]), _F([5, 6, 7, 8, 9, 10])]
    m = frames_to_complex_matrix(frames)
    # Both rows trimmed to the smaller width (2 subcarriers).
    assert m.shape == (2, 2)
