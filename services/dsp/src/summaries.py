from __future__ import annotations

from aether_protocol import DerivedWindow

from .motion import motion_label
from .occupancy import occupancy_label


def room_summary(window: DerivedWindow) -> dict[str, object]:
    """Structured live summary for the API. Only reports things we measured."""
    confidence = min(
        window.quality_score,
        max(window.occupancy_score, min(window.motion_score / 8.0, 1.0)),
    )
    measured: dict[str, object] = {
        "packet_rate_hz": window.packet_rate_hz,
        "expected_packet_rate_hz": window.expected_packet_rate_hz,
        "mean_rssi_dbm": window.mean_rssi_dbm,
        "motion_score": window.motion_score,
        "occupancy_score": window.occupancy_score,
        "anomaly_score": window.anomaly_score,
    }
    diagnostics: dict[str, object] = {
        "packet_loss_ratio": window.packet_loss_ratio,
        "first_word_invalid_ratio": window.first_word_invalid_ratio,
        "jitter_ms": window.jitter_ms,
        "baseline_calibrated": window.baseline_calibrated,
    }
    return {
        "schema_version": "room_summary.v1",
        "session_id": window.session_id,
        "source_mode": window.source_mode,
        "timestamp_ns": window.window_end_ns,
        "quality_score": window.quality_score,
        "confidence": confidence,
        "occupancy": occupancy_label(window),
        "motion": motion_label(window),
        "measured": measured,
        "diagnostics": diagnostics,
        "unknowns": [
            "identity",
            "emotion",
            "medical meaning",
            "heartbeat",
            "validated respiration",
        ],
    }
