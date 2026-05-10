from __future__ import annotations

from aether_protocol import DerivedWindow


# After baseline subtraction + bandpass, motion_score is in raw amplitude
# units. Empty-room values typically sit well below 1.0; someone moving in
# the link drives them well past 1.5. Without a calibrated baseline the
# score is roughly the per-subcarrier amplitude std, so it lands an order of
# magnitude higher; we use two thresholds.
THRESHOLD_CALIBRATED = 1.2
THRESHOLD_UNCALIBRATED = 4.0


def motion_label(window: DerivedWindow, threshold: float | None = None) -> str:
    if window.quality_score < 0.3:
        return "unknown_low_quality"
    if threshold is None:
        threshold = THRESHOLD_CALIBRATED if window.baseline_calibrated else THRESHOLD_UNCALIBRATED
    return "motion_detected" if window.motion_score >= threshold else "still_or_low_motion"
