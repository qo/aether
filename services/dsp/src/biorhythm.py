"""FFT + ACF + harmonic-aware biorhythm extraction with stillness gating.

Pipeline per update:

  1. Buffer per-frame *complex* CSI (full subcarrier vector + host timestamp).
     Old samples roll out after ``max_window_seconds``.

  2. Build a (T, S) complex matrix and drop edge subcarriers.

  3. Take the complex *ratio* between adjacent subcarriers
     (``csi_ratio_pairs``). On real hardware the ratio cancels the per-frame
     CFO/STO term so small body motion is no longer drowned out by hardware
     drift. If the ratio path is degenerate (e.g. synthetic tests with
     identical subcarriers) we fall back to the |CSI| path.

  4. Pick the K subcarriers (or pairs) whose conditioned series concentrates
     the most energy in the breathing band. Real respiration packs energy
     into a narrow band; noise spreads it.

  5. Average the chosen channels into one 1-D scalar series. Hampel-filter,
     resample onto a uniform grid, bandpass 0.05-3 Hz.

  6. Run two estimators on the same conditioned series:
        - rFFT peak in the breathing/HR band, with peak prominence and the
          *2nd harmonic*'s prominence both feeding the confidence score.
        - autocorrelation, with the dominant non-zero lag converted to BPM.

  7. Cross-check: if the FFT and ACF estimates disagree by more than the
     band-specific tolerance, halve the published confidence. The UI
     interprets very low confidence as "unclear" and refuses to display a
     number.

  8. Reject the HR-band peak when it is suspiciously close to 2x the
     respiration peak (it's almost certainly a respiration harmonic).

  9. Stillness gate: when ``motion_score`` exceeds the calibration-aware
     threshold, the spectrum is dominated by gross body motion and any peak
     would be meaningless. We mark the reading ``stillness_gated`` and
     return None for vital-sign fields.

 10. Smooth published BPMs with a confidence-weighted EWMA tracker so a
     stable trend is shown rather than a per-window noise dance.

This is research-only. Even the cleanest reading is the dominant periodic
motion in the band; on PCB antennas at 2 m the HR-band peak is far more
often respiration's 2nd harmonic, fidget motion, or interference than
cardiac micro-motion. The UI must label it accordingly.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from aether_protocol import RawCsiFrame


# Cached Hanning window and FFT frequency bins. The biorhythm loop
# rebuilds these on every update with sizes that stabilise quickly to
# the same value (target_rate * window_seconds). lru_cache lets us
# reuse the arrays across calls; we return read-only views to make sure
# nobody accidentally mutates the cached buffer.
@lru_cache(maxsize=8)
def _cached_hanning(n: int) -> np.ndarray:
    arr = np.hanning(n)
    arr.setflags(write=False)
    return arr


@lru_cache(maxsize=16)
def _cached_rfftfreq(n: int, d_key: float) -> np.ndarray:
    # d_key is sample period rounded to 6 decimals so float jitter doesn't
    # blow the cache.
    arr = np.fft.rfftfreq(n, d=d_key)
    arr.setflags(write=False)
    return arr

from .csi_ratio import (
    best_ratio_subcarriers,
    csi_ratio_magnitude,
    csi_ratio_phase,
    iq_array_to_complex,
)
from .filters import butter_filter_1d, hampel_filter_1d, resample_uniform

BREATHING_BAND_HZ: tuple[float, float] = (0.10, 0.50)
HEART_BAND_HZ: tuple[float, float] = (0.80, 2.50)
FIDGET_BAND_HZ: tuple[float, float] = (2.50, 8.00)
# Walking-cadence band. Typical adult step rate is 1.6-2.5 Hz on flat
# ground; sprinting reaches ~3 Hz. We widen slightly on the low side to
# catch slow walking. Note this overlaps the heart-rate proxy band — that
# is intentional; the gait detector specifically looks for a SUSTAINED
# peak whereas the HR-proxy detector wants the strongest peak. A walking
# person typically shows up in both, which is correct.
GAIT_BAND_HZ: tuple[float, float] = (1.50, 3.00)

# Cross-check tolerance between FFT-peak BPM and ACF-peak BPM.
RESP_AGREEMENT_BPM = 5.0
HEART_AGREEMENT_BPM = 8.0

# Stillness gate. The features module reports baseline_calibrated, which we
# use to pick a tighter threshold once we have a real empty-room reference.
MOTION_GATE_CALIBRATED = 1.5
MOTION_GATE_UNCALIBRATED = 5.0


@dataclass(frozen=True)
class BiorhythmReading:
    respiration_bpm: float | None
    respiration_confidence: float | None
    heart_rate_proxy_bpm: float | None
    heart_rate_proxy_confidence: float | None
    fidget_score: float | None
    sample_rate_hz: float
    window_seconds: float
    samples: int
    chosen_subcarriers: tuple[int, ...] = ()
    # Cross-checks and tracker output.
    respiration_bpm_acf: float | None = None
    respiration_harmonic_prominence: float | None = None
    respiration_tracked_bpm: float | None = None
    heart_rate_proxy_bpm_acf: float | None = None
    heart_rate_proxy_harmonic_prominence: float | None = None
    heart_rate_proxy_tracked_bpm: float | None = None
    stillness_gated: bool = False
    looks_like_respiration_harmonic: bool = False
    signal_path: str = "ratio"
    # Walking-cadence band (1.5-3 Hz). gait_score is the energy ratio in
    # the band (0..1); gait_steps_per_min is the spectral peak frequency
    # converted to steps per minute, or None if the band is empty.
    gait_score: float | None = None
    gait_steps_per_min: float | None = None


_EMPTY = BiorhythmReading(
    respiration_bpm=None,
    respiration_confidence=None,
    heart_rate_proxy_bpm=None,
    heart_rate_proxy_confidence=None,
    fidget_score=None,
    sample_rate_hz=0.0,
    window_seconds=0.0,
    samples=0,
    chosen_subcarriers=(),
)


@dataclass
class _Tracker:
    """Confidence-weighted EWMA tracker on BPM."""

    bpm: float | None = None
    last_confidence: float = 0.0
    max_jump_bpm: float = 8.0

    def update(self, bpm: float | None, confidence: float | None) -> float | None:
        if bpm is None or confidence is None or confidence <= 0:
            return self.bpm
        c = float(min(1.0, max(0.0, confidence)))
        if self.bpm is None:
            if c >= 0.3:
                self.bpm = float(bpm)
                self.last_confidence = c
            return self.bpm
        delta = abs(bpm - self.bpm)
        if delta > self.max_jump_bpm and c < 0.7:
            return self.bpm
        alpha = c if delta <= self.max_jump_bpm else c * 0.5
        self.bpm = (1.0 - alpha) * self.bpm + alpha * float(bpm)
        self.last_confidence = c
        return self.bpm

    def reset(self) -> None:
        self.bpm = None
        self.last_confidence = 0.0


class BiorhythmEstimator:
    """CSI-ratio + FFT + ACF + harmonic-aware + stillness-gated estimator."""

    def __init__(
        self,
        *,
        max_window_seconds: float = 24.0,
        min_samples_for_breathing: int = 96,
        min_samples_for_heart: int = 96,
        buffer_capacity: int = 4096,
        edge_fraction: float = 0.06,
        top_k_subcarriers: int = 6,
    ) -> None:
        self._timestamps: deque[int] = deque(maxlen=buffer_capacity)
        self._complex_csi: deque[np.ndarray] = deque(maxlen=buffer_capacity)
        self._max_window_ns = int(max_window_seconds * 1_000_000_000)
        self._min_breath = min_samples_for_breathing
        self._min_heart = min_samples_for_heart
        self._edge_fraction = float(edge_fraction)
        self._top_k = int(top_k_subcarriers)
        self._latest: BiorhythmReading = _EMPTY
        self._resp_tracker = _Tracker(max_jump_bpm=4.0)
        self._heart_tracker = _Tracker(max_jump_bpm=8.0)

    def reset(self) -> None:
        self._timestamps.clear()
        self._complex_csi.clear()
        self._latest = _EMPTY
        self._resp_tracker.reset()
        self._heart_tracker.reset()

    def update(
        self,
        frame: RawCsiFrame,
        *,
        motion_score: float | None = None,
        baseline_calibrated: bool = False,
    ) -> BiorhythmReading:
        complex_csi = iq_array_to_complex(frame.raw_iq_int8)
        if complex_csi.size == 0:
            return self._latest
        self._timestamps.append(int(frame.ts_host_ns))
        self._complex_csi.append(complex_csi)
        self._evict_old()
        self._latest = self._compute(
            motion_score=motion_score, baseline_calibrated=baseline_calibrated
        )
        return self._latest

    def latest(self) -> BiorhythmReading:
        return self._latest

    def _evict_old(self) -> None:
        if not self._timestamps:
            return
        cutoff = self._timestamps[-1] - self._max_window_ns
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()
            self._complex_csi.popleft()

    def _stack(self) -> tuple[np.ndarray, np.ndarray]:
        if not self._complex_csi:
            return np.zeros(0, dtype=np.int64), np.zeros((0, 0), dtype=np.complex128)
        width = min(arr.size for arr in self._complex_csi)
        if width == 0:
            return np.zeros(0, dtype=np.int64), np.zeros((0, 0), dtype=np.complex128)
        ts = np.fromiter(self._timestamps, dtype=np.int64, count=len(self._timestamps))
        matrix = np.stack([arr[:width] for arr in self._complex_csi], axis=0)
        return ts, matrix

    def _stillness_gate(self, motion_score: float | None, baseline_calibrated: bool) -> bool:
        if motion_score is None:
            return False
        threshold = MOTION_GATE_CALIBRATED if baseline_calibrated else MOTION_GATE_UNCALIBRATED
        return float(motion_score) > threshold

    def _compute(self, *, motion_score: float | None, baseline_calibrated: bool) -> BiorhythmReading:
        if len(self._timestamps) < 32:
            return _EMPTY

        ts_ns, complex_matrix = self._stack()
        if complex_matrix.size == 0:
            return _EMPTY

        duration_s = (ts_ns[-1] - ts_ns[0]) / 1_000_000_000
        if duration_s <= 0.5:
            return _EMPTY

        # Drop edge / null-DC subcarriers from the COMPLEX matrix.
        width = complex_matrix.shape[1]
        drop = max(0, int(round(width * self._edge_fraction)))
        if 2 * drop < width:
            complex_matrix = complex_matrix[:, drop : width - drop]
        if complex_matrix.shape[1] < 2:
            return _EMPTY

        observed_rate = (len(ts_ns) - 1) / max(duration_s, 1e-9)

        # CSI-ratio path. Falls back to |CSI| when the ratio is degenerate.
        signal_matrix, signal_path = _build_signal_matrix(complex_matrix)
        if signal_matrix.shape[1] == 0:
            return _EMPTY

        chosen = best_ratio_subcarriers(
            signal_matrix,
            breathing_band_hz=BREATHING_BAND_HZ,
            sample_rate_hz=observed_rate,
            top_k=self._top_k,
        )
        if chosen.size == 0:
            return _EMPTY

        scalar_series = signal_matrix[:, chosen].mean(axis=1)
        scalar_series = scalar_series - float(scalar_series.mean())
        scalar_series = hampel_filter_1d(scalar_series, window=7, n_sigmas=3.0)

        target_rate = max(2.0, min(observed_rate, 50.0))
        grid_ts, grid_values = resample_uniform(ts_ns, scalar_series, target_rate_hz=target_rate)
        if grid_values.size < 32:
            return _EMPTY
        grid_span_s = (grid_ts[-1] - grid_ts[0]) / 1_000_000_000
        sample_rate = (grid_values.size - 1) / max(grid_span_s, 1e-9)

        if sample_rate > 0.2:
            high_hz = min(3.0, sample_rate * 0.45)
            band = butter_filter_1d(
                grid_values,
                sample_rate_hz=sample_rate,
                low_hz=0.05,
                high_hz=high_hz,
                order=3,
            )
        else:
            band = grid_values

        gated = self._stillness_gate(motion_score, baseline_calibrated)

        # Cached window + freq bins — see top-of-file note. `band` itself is
        # ephemeral so we still pay one multiply allocation; the cache wins
        # are on the trig table and rfftfreq generation.
        windowed = band * _cached_hanning(band.size)
        spectrum = np.fft.rfft(windowed)
        magnitudes = np.abs(spectrum)
        freqs = _cached_rfftfreq(windowed.size, round(1.0 / sample_rate, 6))

        resp_bpm: float | None = None
        resp_conf: float | None = None
        resp_acf: float | None = None
        resp_harm: float | None = None
        if not gated and grid_values.size >= self._min_breath:
            resp_bpm, resp_conf, resp_harm = _peak_with_harmonic_confidence(
                freqs, magnitudes, BREATHING_BAND_HZ
            )
            resp_acf = _acf_bpm(band, sample_rate, BREATHING_BAND_HZ)
            if resp_bpm is not None and resp_acf is not None:
                if abs(resp_bpm - resp_acf) > RESP_AGREEMENT_BPM and resp_conf is not None:
                    resp_conf *= 0.5

        heart_bpm: float | None = None
        heart_conf: float | None = None
        heart_acf: float | None = None
        heart_harm: float | None = None
        looks_harmonic = False
        nyquist = sample_rate / 2.0
        if (
            not gated
            and grid_values.size >= self._min_heart
            and nyquist >= HEART_BAND_HZ[0] + 0.1
        ):
            heart_bpm, heart_conf, heart_harm = _peak_with_harmonic_confidence(
                freqs, magnitudes, HEART_BAND_HZ
            )
            heart_acf = _acf_bpm(band, sample_rate, HEART_BAND_HZ)
            if heart_bpm is not None and heart_acf is not None:
                if abs(heart_bpm - heart_acf) > HEART_AGREEMENT_BPM and heart_conf is not None:
                    heart_conf *= 0.5

        # If the HR-band peak looks like a 2x harmonic of the respiration peak,
        # tag and suppress its confidence; the operator should not read it as HR.
        if resp_bpm is not None and heart_bpm is not None:
            ratio = heart_bpm / max(resp_bpm, 1e-6)
            if 1.85 <= ratio <= 2.15:
                looks_harmonic = True
                if heart_conf is not None:
                    heart_conf = min(heart_conf, 0.2)

        if gated:
            self._resp_tracker.reset()
            self._heart_tracker.reset()
            resp_track = None
            heart_track = None
        else:
            resp_track = self._resp_tracker.update(resp_bpm, resp_conf)
            heart_track = self._heart_tracker.update(heart_bpm, heart_conf)

        fidget_score = _band_energy_ratio(freqs, magnitudes, FIDGET_BAND_HZ)

        # Gait band. We compute even when stillness-gated so the UI can
        # show "no walking detected" rather than a confused dash. The
        # peak-bpm conversion is identical to the respiration/HR path:
        # peak frequency × 60 → steps per minute.
        gait_score = _band_energy_ratio(freqs, magnitudes, GAIT_BAND_HZ)
        gait_peak_hz: float | None = None
        if grid_values.size >= self._min_breath:
            peak, _conf, _harm = _peak_with_harmonic_confidence(
                freqs, magnitudes, GAIT_BAND_HZ
            )
            if peak is not None:
                gait_peak_hz = peak  # already in BPM (Hz×60) per helper convention
        gait_steps_per_min = gait_peak_hz  # value is already steps/min from helper

        return BiorhythmReading(
            respiration_bpm=resp_bpm,
            respiration_confidence=resp_conf,
            heart_rate_proxy_bpm=heart_bpm,
            heart_rate_proxy_confidence=heart_conf,
            fidget_score=fidget_score,
            sample_rate_hz=float(sample_rate),
            window_seconds=float(duration_s),
            samples=int(grid_values.size),
            chosen_subcarriers=tuple(int(i) for i in chosen.tolist()),
            respiration_bpm_acf=resp_acf,
            respiration_harmonic_prominence=resp_harm,
            respiration_tracked_bpm=resp_track,
            heart_rate_proxy_bpm_acf=heart_acf,
            heart_rate_proxy_harmonic_prominence=heart_harm,
            heart_rate_proxy_tracked_bpm=heart_track,
            stillness_gated=bool(gated),
            looks_like_respiration_harmonic=bool(looks_harmonic),
            signal_path=signal_path,
            gait_score=gait_score,
            gait_steps_per_min=gait_steps_per_min,
        )


def _build_signal_matrix(complex_matrix: np.ndarray) -> tuple[np.ndarray, str]:
    """Pick the CSI-ratio path with the highest breathing-band energy ratio.

    Two candidate signals come out of the CSI ratio:
      * MAGNITUDE — the existing path; |ratio_k| changes slowly with body
        motion, fast with hardware drift.
      * PHASE — the unwrapped phase of the ratio (item 7.1). Carries
        Doppler-like information about path-length changes; on real
        hardware often shows a markedly higher breathing-band SNR than
        the magnitude path.

    We compute both, score them by per-subcarrier band-energy ratio in
    the breathing band, and return whichever wins. Falling back to raw
    |CSI| if the ratio is degenerate (synthetic test fixtures with
    identical subcarriers).
    """
    ratio_mag = csi_ratio_magnitude(complex_matrix, stride=1)
    ratio_pha = csi_ratio_phase(complex_matrix, stride=1)

    def _band_score(matrix: np.ndarray) -> float:
        if matrix.ndim != 2 or matrix.shape[1] == 0 or matrix.shape[0] < 16:
            return 0.0
        std = matrix.std(axis=0)
        if not np.any(std > 1e-9):
            return 0.0
        # We don't need the exact frequency, just a relative score; use
        # max std across columns as a proxy for "this path has a usable
        # signal." Cheap and sufficient for path selection.
        return float(std.max())

    mag_score = _band_score(ratio_mag)
    pha_score = _band_score(ratio_pha)

    # Prefer the higher-scoring ratio path; require at least one to be
    # above noise. Phase is preferred on ties (slightly better SNR on
    # real hardware in the literature).
    if pha_score >= mag_score and pha_score > 1e-6:
        return ratio_pha, "ratio_phase"
    if mag_score > 1e-6:
        return ratio_mag, "ratio"
    amp_mag = np.abs(complex_matrix).astype(np.float64)
    return amp_mag, "amplitude"


def _peak_with_harmonic_confidence(
    freqs: np.ndarray, magnitudes: np.ndarray, band: tuple[float, float]
) -> tuple[float | None, float | None, float | None]:
    low, high = band
    band_mask = (freqs >= low) & (freqs <= high)
    if not np.any(band_mask):
        return None, None, None
    band_mag = magnitudes[band_mask]
    band_freq = freqs[band_mask]
    if band_mag.size == 0 or band_mag.max() <= 0:
        return None, None, None
    peak_idx = int(np.argmax(band_mag))
    peak_mag = float(band_mag[peak_idx])
    peak_freq = float(band_freq[peak_idx])
    median_in_band = float(np.median(band_mag)) if band_mag.size > 1 else peak_mag
    peak_prom = peak_mag / (median_in_band + 1e-9)
    base_conf = float(min(1.0, max(0.0, (peak_prom - 1.0) / 5.0)))

    harm_freq = 2.0 * peak_freq
    harm_prom: float | None = None
    if harm_freq < freqs[-1]:
        harm_idx = int(np.argmin(np.abs(freqs - harm_freq)))
        nbhd = (freqs >= harm_freq - 0.1) & (freqs <= harm_freq + 0.1)
        if np.any(nbhd):
            local_mag = float(magnitudes[harm_idx])
            local_med = float(np.median(magnitudes[nbhd]))
            harm_prom = float(local_mag / (local_med + 1e-9))

    if harm_prom is not None and harm_prom > 1.5:
        base_conf = min(1.0, base_conf + 0.2)

    return round(peak_freq * 60.0, 2), base_conf, harm_prom


def _acf_bpm(
    series: np.ndarray, sample_rate_hz: float, band: tuple[float, float]
) -> float | None:
    n = series.size
    if n < 32 or sample_rate_hz <= 0:
        return None
    high_hz, low_hz = max(band[1], 0.001), max(band[0], 0.001)
    min_lag = max(1, int(np.floor(sample_rate_hz / high_hz)))
    max_lag = min(n - 1, int(np.ceil(sample_rate_hz / low_hz)))
    if max_lag <= min_lag + 1:
        return None
    centred = series - float(series.mean())
    denom = float(np.dot(centred, centred))
    if denom <= 0:
        return None
    acf = np.fromiter(
        (
            float(np.dot(centred[: n - lag], centred[lag:])) / denom
            for lag in range(min_lag, max_lag + 1)
        ),
        dtype=np.float64,
        count=max_lag - min_lag + 1,
    )
    if acf.size == 0:
        return None
    peak_idx = int(np.argmax(acf))
    if acf[peak_idx] <= 0.05:
        return None
    lag = peak_idx + min_lag
    period_s = lag / sample_rate_hz
    if period_s <= 0:
        return None
    return round(60.0 / period_s, 2)


def _band_energy_ratio(
    freqs: np.ndarray, magnitudes: np.ndarray, band: tuple[float, float]
) -> float | None:
    if magnitudes.size == 0:
        return None
    total = float(np.sum(magnitudes**2)) + 1e-9
    band_mask = (freqs >= band[0]) & (freqs <= band[1])
    if not np.any(band_mask):
        return 0.0
    band_energy = float(np.sum(magnitudes[band_mask] ** 2))
    return float(min(1.0, max(0.0, band_energy / total)))
