from __future__ import annotations

from aether_protocol import DerivedWindow


def occupancy_label(window: DerivedWindow, threshold: float = 0.35) -> str:
    if window.quality_score < 0.3:
        return "unknown_low_quality"
    if not window.baseline_calibrated:
        # Without an empty-room baseline we cannot honestly distinguish
        # "occupied" from "the room is just like this". Surface that.
        if window.occupancy_score >= threshold:
            return "perturbation_detected_uncalibrated"
        return "uncalibrated"
    return "occupied" if window.occupancy_score >= threshold else "empty_or_baseline"
