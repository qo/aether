"""Window-level feature extraction from a deque of RawCsiFrames.

Pipeline (per derived window of N frames):

    1. Build a (T, S) amplitude matrix from raw I/Q.
    2. Drop edge / null-DC subcarriers.
    3. Hampel-filter each subcarrier in time to suppress impulsive glitches
       (the kind that show up when ``first_word_invalid`` packets sneak through
       or the radio renormalises gain).
    4. Subtract the per-subcarrier baseline mean (if a baseline has been
       calibrated, otherwise centre on the window mean).
    5. Detrend each subcarrier and bandpass 0.05-5 Hz so we keep
       respiration / body-motion energy and reject DC drift + HF noise.
    6. Compute motion_score, anomaly_score, occupancy_score from the
       conditioned signal, weighted by per-subcarrier SNR when available.
    7. Compute link diagnostics: packet rate vs expected, packet-loss ratio
       from sequence gaps, inter-arrival jitter, first_word_invalid ratio.

Everything besides the feature numbers themselves is exposed in the returned
DerivedWindow as optional diagnostic fields so the UI can show the operator
exactly what the link is doing.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from aether_protocol import DerivedWindow, RawCsiFrame

from .calibration import BaselineCalibrator
from .filters import (
    butter_filter_columns,
    detrend_columns,
    hampel_filter_columns,
)
from .preprocessing import (
    drop_edge_subcarriers,
    frames_to_amplitude_matrix,
    frames_to_phase_matrix,
)

# Body-motion / respiration band of interest. The lower edge has to be small
# enough to keep slow breathing (~0.1 Hz / 6 BPM) and large enough to reject
# AGC drift; the upper edge keeps gross body motion and rejects high-frequency
# CSI noise.
MOTION_BAND_HZ: tuple[float, float] = (0.05, 5.0)


@dataclass(frozen=True)
class LinkDiagnostics:
    packet_rate_hz: float
    expected_packet_rate_hz: float | None
    packet_loss_ratio: float | None
    jitter_ms: float | None
    first_word_invalid_ratio: float
    valid_ratio: float
    rssi_stability: float


def derive_window(
    frames: list[RawCsiFrame],
    *,
    calibrator: BaselineCalibrator | None = None,
    expected_packet_rate_hz: float | None = 20.0,
) -> DerivedWindow:
    if not frames:
        raise ValueError("cannot derive a window from zero frames")

    diag = _link_diagnostics(frames, expected_packet_rate_hz=expected_packet_rate_hz)

    amp_matrix_full = frames_to_amplitude_matrix(frames)
    if amp_matrix_full.size == 0:
        return _empty_window(frames, diag)

    # Drop edge / null-DC subcarriers - they are dominated by hardware artefacts.
    amp_matrix, _kept_idx = drop_edge_subcarriers(amp_matrix_full, edge_fraction=0.06)
    if amp_matrix.size == 0:
        return _empty_window(frames, diag)

    # Hampel along the time axis kills single-frame spikes per subcarrier.
    amp_filtered = hampel_filter_columns(amp_matrix, window=7, n_sigmas=3.0)

    # Per-subcarrier mean (used by the calibrator and as the "amplitude_mean"
    # surface readout) is computed before bandpass so it represents the true
    # CSI amplitude, not the high-pass residual.
    amplitude_mean = amp_filtered.mean(axis=0)
    amplitude_std_raw = amp_filtered.std(axis=0)

    # Subtract baseline mean (per-column) so motion is measured as a delta
    # from "what the empty room looks like" rather than from absolute amplitude.
    baseline_calibrated = bool(calibrator and calibrator.is_calibrated)
    if calibrator is not None:
        centred = calibrator.subtract_baseline(amp_filtered)
    else:
        centred = amp_filtered - amplitude_mean.reshape(1, -1)

    # Detrend + bandpass each subcarrier independently. Sample rate is whatever
    # the firmware actually delivered to us in this window, not what we wanted.
    detrended = detrend_columns(centred)
    sample_rate_hz = max(1.0, diag.packet_rate_hz or 1.0)
    conditioned = butter_filter_columns(
        detrended,
        sample_rate_hz=sample_rate_hz,
        low_hz=MOTION_BAND_HZ[0],
        high_hz=min(MOTION_BAND_HZ[1], sample_rate_hz * 0.4),
        order=3,
    )

    # SNR-weighted motion / anomaly scores. Subcarriers that wobbled in the
    # empty-room baseline get downweighted; clean ones drive the readout.
    weights = None
    if calibrator is not None:
        weights = calibrator.snr_weights()
    if weights is None or weights.size != conditioned.shape[1]:
        weights = np.ones(conditioned.shape[1], dtype=np.float64) / max(1, conditioned.shape[1])

    # Motion score: weighted RMS of conditioned per-subcarrier signal.
    rms_per_col = np.sqrt((conditioned ** 2).mean(axis=0))
    motion_score = float(np.dot(rms_per_col, weights))

    # Anomaly score: weighted L2 distance per-subcarrier mean from baseline.
    if calibrator is not None and calibrator.is_calibrated:
        baseline_mean = calibrator.baseline_amplitude()
        # Re-trim baseline to match the columns we kept.
        if baseline_mean is not None and baseline_mean.size >= amp_matrix.shape[1]:
            # Apply same trimming as drop_edge_subcarriers used.
            full_width = amp_matrix_full.shape[1]
            drop = (full_width - amp_matrix.shape[1]) // 2
            base_trimmed = baseline_mean[drop : drop + amp_matrix.shape[1]]
        else:
            base_trimmed = amplitude_mean
        delta = np.abs(amplitude_mean - base_trimmed)
        anomaly_score = float(np.dot(delta, weights))
    else:
        # Without a baseline there is no meaningful anomaly. We surface a
        # dynamic-range based proxy so the UI does not flatline at zero.
        anomaly_score = float(amplitude_std_raw.mean())

    # Occupancy: anomaly normalised by an expected baseline-noise-magnitude
    # scale. With a calibrated baseline we use the baseline std; otherwise we
    # fall back to a fixed scale of 6 amplitude units.
    if calibrator is not None and calibrator.is_calibrated:
        base_std = calibrator.baseline_std()
        scale = float(base_std.mean()) if base_std is not None else 1.0
        scale = max(scale, 0.5)
        occupancy_score = float(min(1.0, max(0.0, anomaly_score / (4.0 * scale))))
    else:
        occupancy_score = float(min(1.0, max(0.0, anomaly_score / 18.0)))

    # Phase mean - kept for spectral inspection in the UI.
    phase_matrix = frames_to_phase_matrix(frames)
    if phase_matrix.size and phase_matrix.shape[1] >= amp_matrix.shape[1]:
        phase_trim = phase_matrix[:, : amp_matrix.shape[1]]
        phase_mean = phase_trim.mean(axis=0).tolist()
    else:
        phase_mean = [0.0] * amp_matrix.shape[1]

    # Composite quality score: weights packet-rate adequacy, frame validity,
    # RSSI stability, and a jitter penalty.
    packet_quality = 0.0
    if expected_packet_rate_hz and expected_packet_rate_hz > 0:
        packet_quality = min(1.0, max(0.0, diag.packet_rate_hz / expected_packet_rate_hz))
    else:
        packet_quality = min(1.0, diag.packet_rate_hz / 20.0)
    jitter_penalty = 1.0
    if diag.jitter_ms is not None and diag.packet_rate_hz > 0:
        expected_period_ms = 1000.0 / diag.packet_rate_hz
        if expected_period_ms > 0:
            jitter_penalty = float(max(0.0, 1.0 - (diag.jitter_ms / max(expected_period_ms, 1e-3))))
    quality_score = float(
        max(
            0.0,
            min(
                1.0,
                0.40 * diag.valid_ratio
                + 0.30 * packet_quality
                + 0.15 * diag.rssi_stability
                + 0.15 * jitter_penalty,
            ),
        )
    )

    return DerivedWindow(
        session_id=frames[0].session_id,
        device_id=frames[0].device_id,
        window_start_ns=frames[0].ts_host_ns,
        window_end_ns=frames[-1].ts_host_ns,
        packet_count=len(frames),
        packet_rate_hz=diag.packet_rate_hz,
        mean_rssi_dbm=float(np.mean([float(frame.rssi_dbm) for frame in frames])),
        subcarrier_count=int(amplitude_mean.size),
        amplitude_mean=amplitude_mean.tolist(),
        amplitude_std=amplitude_std_raw.tolist(),
        phase_unwrapped_mean=phase_mean,
        motion_score=motion_score,
        occupancy_score=occupancy_score,
        anomaly_score=anomaly_score,
        quality_score=quality_score,
        respiration_bpm=None,
        respiration_confidence=None,
        packet_loss_ratio=diag.packet_loss_ratio,
        first_word_invalid_ratio=diag.first_word_invalid_ratio,
        jitter_ms=diag.jitter_ms,
        expected_packet_rate_hz=expected_packet_rate_hz,
        baseline_calibrated=baseline_calibrated,
        source_mode=frames[0].source_mode,
    )


def _link_diagnostics(
    frames: list[RawCsiFrame], *, expected_packet_rate_hz: float | None
) -> LinkDiagnostics:
    n = len(frames)
    duration_s = max((frames[-1].ts_host_ns - frames[0].ts_host_ns) / 1_000_000_000, 1e-9)
    # (N-1) inter-arrival intervals among N samples - this is the conventional
    # rate calculation. Using N/duration is biased high by one period.
    packet_rate = (n - 1) / duration_s if n > 1 else 0.0

    valid_count = sum(1 for f in frames if not f.first_word_invalid)
    valid_ratio = valid_count / n if n > 0 else 0.0
    fwi_ratio = 1.0 - valid_ratio

    # Packet loss from monotonic sequence numbers. We assume the firmware
    # increments seq once per CSI callback, so a gap of N means N-1 dropped.
    seqs = [int(f.seq) for f in frames]
    loss_ratio: float | None = None
    if n >= 2:
        expected = seqs[-1] - seqs[0] + 1
        if expected > 0:
            received = n
            loss = max(0, expected - received)
            loss_ratio = float(min(1.0, loss / max(1, expected)))

    # Inter-arrival jitter (ms): std of host-side inter-arrival deltas.
    jitter_ms: float | None = None
    if n >= 3:
        ts = np.array([f.ts_host_ns for f in frames], dtype=np.int64)
        deltas_ns = np.diff(ts)
        if deltas_ns.size:
            jitter_ms = float(np.std(deltas_ns) / 1_000_000.0)

    # RSSI stability: 1 - (std / scale). We use 8 dB as the scale because
    # 8 dB of variability in a stationary link already suggests a flaky AGC.
    rssi_arr = np.array([float(f.rssi_dbm) for f in frames], dtype=np.float64)
    rssi_stability = float(max(0.0, 1.0 - (np.std(rssi_arr) / 8.0))) if rssi_arr.size else 0.0

    return LinkDiagnostics(
        packet_rate_hz=float(packet_rate),
        expected_packet_rate_hz=expected_packet_rate_hz,
        packet_loss_ratio=loss_ratio,
        jitter_ms=jitter_ms,
        first_word_invalid_ratio=float(fwi_ratio),
        valid_ratio=float(valid_ratio),
        rssi_stability=rssi_stability,
    )


def _empty_window(frames: list[RawCsiFrame], diag: LinkDiagnostics) -> DerivedWindow:
    return DerivedWindow(
        session_id=frames[0].session_id,
        device_id=frames[0].device_id,
        window_start_ns=frames[0].ts_host_ns,
        window_end_ns=frames[-1].ts_host_ns,
        packet_count=len(frames),
        packet_rate_hz=diag.packet_rate_hz,
        mean_rssi_dbm=float(np.mean([float(frame.rssi_dbm) for frame in frames])),
        subcarrier_count=0,
        amplitude_mean=[],
        amplitude_std=[],
        phase_unwrapped_mean=[],
        motion_score=0.0,
        occupancy_score=0.0,
        anomaly_score=0.0,
        quality_score=0.0,
        respiration_bpm=None,
        respiration_confidence=None,
        packet_loss_ratio=diag.packet_loss_ratio,
        first_word_invalid_ratio=diag.first_word_invalid_ratio,
        jitter_ms=diag.jitter_ms,
        expected_packet_rate_hz=diag.expected_packet_rate_hz,
        baseline_calibrated=False,
        source_mode=frames[0].source_mode,
    )
