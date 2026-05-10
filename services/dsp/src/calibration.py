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


# Acceptance thresholds for a baseline to be trusted. If any are exceeded
# during the calibration window we mark the baseline as "rejected" so the
# UI can prompt the operator to redo it instead of silently treating a
# noisy capture as ground truth.
_BASELINE_REJECT_RSSI_STD_DB = 4.0
_BASELINE_REJECT_RATE_FLOOR_HZ = 5.0  # link must sustain at least this rate
_BASELINE_MIN_FRAMES = 100


class BaselineCalibrator:
    """Rolling per-subcarrier baseline. Streaming Welford accumulator.

    Calibration acceptance: a baseline is only marked "calibrated" when the
    observed link during the calibration window cleared a few sanity gates
    (enough frames, RSSI std bounded, no obvious motion). When rejected, the
    calibrator stays in 'is_calibrating=False, is_calibrated=False' with a
    populated ``last_rejection_reason`` so the UI can explain *why*.
    """

    def __init__(self) -> None:
        self._n: int = 0
        self._mean: np.ndarray | None = None
        self._m2: np.ndarray | None = None
        self._first_ts_ns: int | None = None
        self._last_ts_ns: int | None = None
        self._calibrating: bool = False
        self._target_seconds: float = 0.0
        self._target_frames: int = 0
        # Acceptance evidence accumulated during the calibration window.
        self._rssi_samples: list[float] = []
        self._motion_observed_max: float = 0.0
        self._last_rejection_reason: str | None = None
        self._accepted: bool = False
        # Drift tracking (item 8.3). EWMA of per-subcarrier amplitude during
        # post-calibration "still" frames. Compared periodically with the
        # captured baseline to detect thermal/AGC/scene drift that would
        # invalidate downstream motion + occupancy thresholds.
        self._drift_ewma: np.ndarray | None = None
        self._drift_alpha: float = 0.05  # ~20-frame time constant
        self._drift_score: float = 0.0
        self._drift_samples: int = 0

    @property
    def is_calibrated(self) -> bool:
        return self._accepted and self._n > 0 and self._mean is not None

    @property
    def is_calibrating(self) -> bool:
        return self._calibrating

    @property
    def last_rejection_reason(self) -> str | None:
        return self._last_rejection_reason

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
        self._rssi_samples = []
        self._motion_observed_max = 0.0
        self._last_rejection_reason = None
        self._accepted = False

    def cancel(self) -> None:
        self._calibrating = False
        self._accepted = False

    def feed(
        self,
        amplitude: np.ndarray,
        *,
        ts_host_ns: int,
        rssi_dbm: float | None = None,
        motion_score: float | None = None,
    ) -> bool:
        """Push one frame's per-subcarrier amplitude into the accumulator.

        ``rssi_dbm`` and ``motion_score`` are advisory inputs used solely for
        baseline acceptance — they are NOT mixed into the amplitude statistics.

        Returns True if calibration just completed on this frame (whether
        accepted or rejected — the caller should check ``is_calibrated`` /
        ``last_rejection_reason``).
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
            self._rssi_samples = []
            self._motion_observed_max = 0.0

        if self._first_ts_ns is None:
            self._first_ts_ns = int(ts_host_ns)
        self._last_ts_ns = int(ts_host_ns)

        self._n += 1
        delta = amplitude.astype(np.float64) - self._mean
        self._mean += delta / self._n
        delta2 = amplitude.astype(np.float64) - self._mean
        assert self._m2 is not None  # for type-checker
        self._m2 += delta * delta2

        if rssi_dbm is not None:
            self._rssi_samples.append(float(rssi_dbm))
        if motion_score is not None and motion_score > self._motion_observed_max:
            self._motion_observed_max = float(motion_score)

        elapsed_s = (self._last_ts_ns - self._first_ts_ns) / 1_000_000_000
        if elapsed_s >= self._target_seconds and self._n >= _BASELINE_MIN_FRAMES:
            self._calibrating = False
            self._evaluate_acceptance(elapsed_s)
            return True
        return False

    def _evaluate_acceptance(self, elapsed_s: float) -> None:
        """Apply Phase B acceptance gates and record rejection reason if any."""
        # Frame count gate (defensive — feed() already requires >= MIN_FRAMES).
        if self._n < _BASELINE_MIN_FRAMES:
            self._accepted = False
            self._last_rejection_reason = (
                f"only {self._n} frames captured during {elapsed_s:.1f}s "
                f"(need {_BASELINE_MIN_FRAMES})"
            )
            return
        # Effective rate gate — if we got 100 frames over 30 s on a "20 Hz" link
        # something is wrong; do not bake that into a baseline.
        observed_rate = self._n / max(elapsed_s, 1e-3)
        if observed_rate < _BASELINE_REJECT_RATE_FLOOR_HZ:
            self._accepted = False
            self._last_rejection_reason = (
                f"link rate {observed_rate:.1f} Hz is below the "
                f"{_BASELINE_REJECT_RATE_FLOOR_HZ:.0f} Hz floor required for "
                "a trustworthy baseline"
            )
            return
        # RSSI stability gate — high std means AGC is fighting the link;
        # the baseline std would be artificially inflated, which would
        # under-call motion downstream.
        if len(self._rssi_samples) >= 2:
            rssi_arr = np.asarray(self._rssi_samples, dtype=np.float64)
            rssi_std = float(rssi_arr.std())
            if rssi_std > _BASELINE_REJECT_RSSI_STD_DB:
                self._accepted = False
                self._last_rejection_reason = (
                    f"RSSI std {rssi_std:.1f} dB exceeded "
                    f"{_BASELINE_REJECT_RSSI_STD_DB:.1f} dB — link too noisy "
                    "for a stable empty-room baseline"
                )
                return
        # Motion gate — operator was expected to keep the room empty/still.
        # If a previous window already showed motion above the uncalibrated
        # floor, the operator was probably moving during calibration.
        if self._motion_observed_max > 6.0:
            self._accepted = False
            self._last_rejection_reason = (
                f"detected motion (peak {self._motion_observed_max:.1f}) during "
                "calibration — keep the room empty for the duration"
            )
            return
        self._accepted = True
        self._last_rejection_reason = None

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
            "last_rejection_reason": self._last_rejection_reason,
            "accepted": self._accepted,
            "drift_score": float(self._drift_score),
            "drift_samples": int(self._drift_samples),
            "drift_detected": bool(self.is_drifting()),
        }

    # ---------- Drift detection (item 8.3) ----------

    DRIFT_WARN_THRESHOLD: float = 0.18
    """RMS-relative drift above this triggers ``drift_detected=True``.

    The score is computed as ``rms(ewma - baseline) / rms(baseline)`` so
    a value of 0.18 corresponds roughly to "the per-subcarrier amplitude
    has drifted 18% on average from the captured baseline." That's well
    past thermal jitter (~3-5%) but below a fully different scene.
    """

    def feed_idle_amplitude(self, amplitude: np.ndarray) -> None:
        """Update the drift EWMA with a frame the runtime believes is "still".

        The runtime calls this only when motion is below the stillness
        threshold AND a baseline is calibrated. Outside those conditions
        we'd be feeding noise into the EWMA and producing false alarms.
        """
        if self._mean is None or amplitude.ndim != 1 or amplitude.size == 0:
            return
        if amplitude.size != self._mean.size:
            return  # subcarrier count changed; ignore until next calibration
        amp = amplitude.astype(np.float64)
        if self._drift_ewma is None:
            self._drift_ewma = amp.copy()
        else:
            a = float(self._drift_alpha)
            self._drift_ewma = (1.0 - a) * self._drift_ewma + a * amp
        self._drift_samples += 1
        baseline = self._mean
        rms_baseline = float(np.sqrt(np.mean(baseline ** 2))) + 1e-9
        rms_delta = float(np.sqrt(np.mean((self._drift_ewma - baseline) ** 2)))
        self._drift_score = rms_delta / rms_baseline

    def is_drifting(self) -> bool:
        """True if the drift EWMA has diverged from baseline beyond threshold.

        Requires at least ~50 still samples accumulated post-calibration to
        avoid declaring drift on the first wobble of a fresh capture.
        """
        return (
            self.is_calibrated
            and self._drift_samples >= 50
            and self._drift_score >= self.DRIFT_WARN_THRESHOLD
        )

    # ---------- Persistence (item 8.2) ----------
    #
    # The Welford-state (n, mean, M2) is enough to fully reconstruct the
    # calibrator. We round to float for JSON friendliness and store
    # acceptance metadata so a restored calibrator behaves identically to
    # one that just finished its own capture.

    def to_persisted_dict(self) -> dict[str, object] | None:
        """Return a JSON-serialisable snapshot or None if not calibrated."""
        if not self.is_calibrated or self._mean is None or self._m2 is None:
            return None
        first_ns = int(self._first_ts_ns) if self._first_ts_ns is not None else None
        last_ns = int(self._last_ts_ns) if self._last_ts_ns is not None else None
        return {
            "version": 1,
            "n": int(self._n),
            "mean": self._mean.tolist(),
            "m2": self._m2.tolist(),
            "first_ts_ns": first_ns,
            "last_ts_ns": last_ns,
            "target_seconds": float(self._target_seconds),
            "accepted": True,
            "rssi_samples_n": len(self._rssi_samples),
            "motion_observed_max": float(self._motion_observed_max),
        }

    @classmethod
    def from_persisted_dict(cls, payload: dict[str, object]) -> "BaselineCalibrator":
        """Rebuild a calibrator from a previously persisted snapshot.

        Tolerates missing fields by falling back to safe defaults — a
        partial payload simply produces a calibrator with reduced metadata
        but still-valid mean/std arrays.
        """
        cal = cls()
        if int(payload.get("version", 1)) != 1:
            return cal  # unknown schema — start fresh
        try:
            mean = np.asarray(payload.get("mean", []), dtype=np.float64)
            m2 = np.asarray(payload.get("m2", []), dtype=np.float64)
        except (TypeError, ValueError):
            return cal
        if mean.size == 0 or mean.size != m2.size:
            return cal
        cal._n = int(payload.get("n", 0))
        cal._mean = mean
        cal._m2 = m2
        first = payload.get("first_ts_ns")
        last = payload.get("last_ts_ns")
        cal._first_ts_ns = int(first) if isinstance(first, int) else None
        cal._last_ts_ns = int(last) if isinstance(last, int) else None
        cal._target_seconds = float(payload.get("target_seconds", 0.0))
        cal._motion_observed_max = float(payload.get("motion_observed_max", 0.0))
        cal._calibrating = False
        cal._accepted = bool(payload.get("accepted", True))
        cal._last_rejection_reason = None
        return cal
