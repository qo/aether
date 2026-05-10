"""Empty-room baseline calibration for CSI motion / occupancy.

Without a baseline, the anomaly score in features.py compared each window
against itself, which always yielded ~0 and made occupancy useless. This
module captures a short empty-room baseline of per-subcarrier mean amplitude
and noise-floor std, then exposes:

  - ``subtract_baseline(amp_matrix)`` -> per-subcarrier delta from baseline.
  - ``snr_weights()`` -> per-subcarrier weight inversely proportional to its
    own empty-room noise. Subcarriers that wobble even with no one in the
    room get downweighted; clean ones dominate the motion / anomaly readout.
  - ``select_responsive_subcarriers(amp_std)`` -> the top-K subcarriers most
    perturbed *relative to baseline noise*. The biorhythm estimator uses this
    to pick which subcarrier carries the strongest periodic signal.

The calibrator is intentionally lightweight - it stores running per-subcarrier
mean and variance using Welford's algorithm so it works with any number of
frames at any subcarrier count without preallocation.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class BaselineSnapshot:
    subcarrier_count: int
    frames_observed: int
    duration_seconds: float
    amplitude_mean: list[float]
    amplitude_std: list[float]
    snr_weights: list[float]


class BaselineCalibrator:
    """Rolling per-subcarrier baseline. Streaming Welford accumulator."""

    def __init__(self) -> None:
        self._n: int = 0
        self._mean: np.ndarray | None = None
        self._m2: np.ndarray | None = None
        self._first_ts_ns: int | None = None
        self._last_ts_ns: int | None = None
        self._calibrating: bool = False
        self._target_seconds: float = 0.0
        self._target_frames: int = 0

    @property
    def is_calibrated(self) -> bool:
        return self._n > 0 and self._mean is not None

    @property
    def is_calibrating(self) -> bool:
        return self._calibrating

    @property
    def frames_observed(self) -> int:
        return self._n

    @property
    def target_seconds(self) -> float:
        return self._target_seconds

    @property
    def progress(self) -> float:
        if not self._calibrating:
            return 1.0 if self.is_calibrated else 0.0
        if self._target_seconds > 0 and self._first_ts_ns and self._last_ts_ns:
            elapsed = (self._last_ts_ns - self._first_ts_ns) / 1_000_000_000
            return float(min(1.0, max(0.0, elapsed / self._target_seconds)))
        return 0.0

    def begin(self, *, duration_seconds: float = 10.0) -> None:
        """Start a new calibration window. Discards any previous baseline."""
        self._n = 0
        self._mean = None
        self._m2 = None
        self._first_ts_ns = None
        self._last_ts_ns = None
        self._calibrating = True
        self._target_seconds = max(0.5, float(duration_seconds))
        self._target_frames = 0

    def cancel(self) -> None:
        self._calibrating = False

    def feed(self, amplitude: np.ndarray, *, ts_host_ns: int) -> bool:
        """Push one frame's per-subcarrier amplitude into the accumulator.

        Returns True if calibration just completed on this frame.
        """
        if not self._calibrating:
            return False
        if amplitude.ndim != 1 or amplitude.size == 0:
            return False

        if self._mean is None:
            self._mean = np.zeros_like(amplitude, dtype=np.float64)
            self._m2 = np.zeros_like(amplitude, dtype=np.float64)
        if amplitude.size != self._mean.size:
            # Subcarrier count changed mid-calibration -> reset.
            self._mean = np.zeros_like(amplitude, dtype=np.float64)
            self._m2 = np.zeros_like(amplitude, dtype=np.float64)
            self._n = 0

        if self._first_ts_ns is None:
            self._first_ts_ns = int(ts_host_ns)
        self._last_ts_ns = int(ts_host_ns)

        self._n += 1
        delta = amplitude.astype(np.float64) - self._mean
        self._mean += delta / self._n
        delta2 = amplitude.astype(np.float64) - self._mean
        assert self._m2 is not None  # for type-checker
        self._m2 += delta * delta2

        # Done when we exceed the requested duration AND have a sane sample count.
        elapsed_s = (self._last_ts_ns - self._first_ts_ns) / 1_000_000_000
        if elapsed_s >= self._target_seconds and self._n >= 32:
            self._calibrating = False
            return True
        return False

    def baseline_amplitude(self) -> np.ndarray | None:
        return None if self._mean is None else self._mean.copy()

    def baseline_std(self) -> np.ndarray | None:
        if self._m2 is None or self._n <= 1:
            return None
        return np.sqrt(self._m2 / max(1, self._n - 1))

    def subtract_baseline(self, amp_matrix: np.ndarray) -> np.ndarray:
        """Return amp_matrix with baseline mean subtracted per column.

        If no baseline exists, falls back to subtracting the column-wise mean of
        the matrix itself, so the system still produces a centered signal.
        """
        if amp_matrix.ndim != 2:
            raise ValueError("expected a 2D (time, subcarrier) matrix")
        baseline = self.baseline_amplitude()
        if baseline is None or baseline.size != amp_matrix.shape[1]:
            return amp_matrix - amp_matrix.mean(axis=0, keepdims=True)
        return amp_matrix - baseline.reshape(1, -1)

    def snr_weights(self, *, eps: float = 1e-3) -> np.ndarray | None:
        """Per-subcarrier weight = 1 / (baseline_std + eps), normalized."""
        std = self.baseline_std()
        if std is None:
            return None
        weights = 1.0 / (std + eps)
        total = float(weights.sum())
        if total <= 0:
            return None
        return weights / total

    def select_responsive_subcarriers(
        self,
        amp_std_now: np.ndarray,
        *,
        top_k: int = 8,
    ) -> np.ndarray:
        """Return the indices of subcarriers most perturbed vs their own baseline noise.

        If no baseline exists, falls back to the highest-variance subcarriers
        of the current window. Always returns at least one index.
        """
        if amp_std_now.ndim != 1 or amp_std_now.size == 0:
            return np.array([0], dtype=np.int64)
        baseline_std = self.baseline_std()
        if baseline_std is None or baseline_std.size != amp_std_now.size:
            score = amp_std_now.astype(np.float64)
        else:
            score = amp_std_now.astype(np.float64) / (baseline_std + 1e-3)
        k = max(1, min(int(top_k), score.size))
        order = np.argsort(score)[::-1]
        return np.sort(order[:k])

    def snapshot(self) -> BaselineSnapshot | None:
        if not self.is_calibrated or self._mean is None:
            return None
        std = self.baseline_std()
        if std is None:
            std = np.zeros_like(self._mean)
        weights = self.snr_weights()
        if weights is None:
            weights = np.ones_like(self._mean) / max(1, self._mean.size)
        duration = 0.0
        if self._first_ts_ns is not None and self._last_ts_ns is not None:
            duration = (self._last_ts_ns - self._first_ts_ns) / 1_000_000_000
        return BaselineSnapshot(
            subcarrier_count=int(self._mean.size),
            frames_observed=self._n,
            duration_seconds=float(duration),
            amplitude_mean=self._mean.tolist(),
            amplitude_std=std.tolist(),
            snr_weights=weights.tolist(),
        )

    def status(self) -> dict[str, object]:
        return {
            "is_calibrated": self.is_calibrated,
            "is_calibrating": self.is_calibrating,
            "frames_observed": self._n,
            "subcarrier_count": int(self._mean.size) if self._mean is not None else 0,
            "target_seconds": self._target_seconds,
            "progress": self.progress,
        }
