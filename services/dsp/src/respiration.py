from __future__ import annotations

from aether_protocol import DerivedWindow


def mark_respiration_experimental(window: DerivedWindow) -> DerivedWindow:
    """Strip respiration fields from a derived window.

    Intentionally NOT called by the runtime today — biorhythm reads ride
    through to the Live Room and 3D view where the UI gates rendering by
    confidence (`respiration_confidence >= 0.30`, `heart_rate_proxy_confidence
    >= 0.45`). This helper is kept available for any caller (export script,
    API consumer) that wants to publish a bundle without the research-only
    fields, which is a stricter gate than the UI's confidence threshold.
    """
    clone = window.model_copy()
    clone.respiration_bpm = None
    clone.respiration_confidence = None
    clone.respiration_bpm_acf = None
    clone.respiration_harmonic_prominence = None
    clone.respiration_tracked_bpm = None
    clone.heart_rate_proxy_bpm = None
    clone.heart_rate_proxy_confidence = None
    clone.heart_rate_proxy_bpm_acf = None
    clone.heart_rate_proxy_harmonic_prominence = None
    clone.heart_rate_proxy_tracked_bpm = None
    return clone
