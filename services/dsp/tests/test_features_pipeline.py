"""End-to-end tests for ``derive_window`` against synthetic frames.

These exercise the new pipeline (Hampel -> baseline subtract -> bandpass ->
weighted RMS / anomaly) and the new diagnostic surfaces (jitter, packet loss,
first-word-invalid ratio, baseline_calibrated flag).
"""
from __future__ import annotations

import math

import numpy as np

from aether_protocol import RawCsiFrame, SourceMode
from services.dsp.src.calibration import BaselineCalibrator
from services.dsp.src.features import derive_window


def _make_frame(*, seq: int, ts_ns: int, iq: list[int], rssi: int = -55, fwi: bool = False) -> RawCsiFrame:
    return RawCsiFrame(
        session_id="t",
        device_id="esp32-s3-rx",
        device_role="rx",
        seq=seq,
        ts_device_us=ts_ns // 1000,
        ts_host_ns=ts_ns,
        channel=6,
        rssi_dbm=rssi,
        noise_floor_dbm=-95,
        sig_mode=0,
        cwb=0,
        secondary_channel=0,
        stbc=0,
        first_word_invalid=fwi,
        payload_len=len(iq),
        raw_iq_int8=iq,
        source_mode=SourceMode.LIVE,
    )


def _flat_iq(n_subcarriers: int, amp: float) -> list[int]:
    """Two int8 per subcarrier, both equal so amplitude == sqrt(2)*|amp|."""
    side = max(-127, min(127, int(round(amp / math.sqrt(2)))))
    return [side, side] * n_subcarriers


def test_derive_window_reports_packet_rate_and_diagnostics() -> None:
    period_ns = 50_000_000  # 20 Hz
    frames = [
        _make_frame(seq=k, ts_ns=k * period_ns, iq=_flat_iq(32, 60))
        for k in range(40)
    ]
    win = derive_window(frames, expected_packet_rate_hz=20.0)
    assert abs(win.packet_rate_hz - 20.0) < 0.5
    assert win.expected_packet_rate_hz == 20.0
    assert win.first_word_invalid_ratio == 0.0
    # Sequential, perfectly-spaced -> jitter near zero, no loss.
    assert win.jitter_ms is not None and win.jitter_ms < 1.0
    assert win.packet_loss_ratio == 0.0


def test_derive_window_detects_packet_loss_from_seq_gaps() -> None:
    period_ns = 50_000_000
    seqs = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12]
    frames = [
        _make_frame(seq=s, ts_ns=k * period_ns, iq=_flat_iq(16, 55))
        for k, s in enumerate(seqs)
    ]
    win = derive_window(frames, expected_packet_rate_hz=20.0)
    # 13 expected, 10 received -> ~23% loss.
    assert win.packet_loss_ratio is not None
    assert 0.15 <= win.packet_loss_ratio <= 0.30


def test_derive_window_marks_invalid_frames() -> None:
    period_ns = 50_000_000
    frames = [
        _make_frame(seq=k, ts_ns=k * period_ns, iq=_flat_iq(16, 55), fwi=(k % 2 == 0))
        for k in range(20)
    ]
    win = derive_window(frames)
    assert win.first_word_invalid_ratio is not None
    assert abs(win.first_word_invalid_ratio - 0.5) < 0.05


def test_derive_window_with_calibrated_baseline_drops_anomaly_for_quiet_room() -> None:
    period_ns = 50_000_000
    rng = np.random.RandomState(11)
    cal = BaselineCalibrator()
    cal.begin(duration_seconds=1.0)
    # Calibration phase: 60 frames of a perfectly stable empty room.
    for k in range(60):
        amp_vec = np.array([60.0 + rng.normal(0, 0.5)] * 32)
        cal.feed(amp_vec, ts_host_ns=k * period_ns)

    # Now derive a quiet window - should have low motion and anomaly.
    frames_quiet = [
        _make_frame(seq=k, ts_ns=(60 + k) * period_ns, iq=_flat_iq(32, 60))
        for k in range(40)
    ]
    quiet = derive_window(frames_quiet, calibrator=cal, expected_packet_rate_hz=20.0)
    assert quiet.baseline_calibrated is True
    assert quiet.motion_score < 1.5
    assert quiet.occupancy_score < 0.5


def test_derive_window_without_calibration_marks_baseline_uncalibrated() -> None:
    period_ns = 50_000_000
    frames = [
        _make_frame(seq=k, ts_ns=k * period_ns, iq=_flat_iq(16, 60))
        for k in range(40)
    ]
    win = derive_window(frames)
    assert win.baseline_calibrated is False
