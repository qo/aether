from __future__ import annotations

from aether_protocol import DerivedWindow


def mark_respiration_experimental(window: DerivedWindow) -> DerivedWindow:
    """V0 respiration remains unavailable until controlled validation supports it."""
    clone = window.model_copy()
    clone.respiration_bpm = None
    clone.respiration_confidence = None
    return clone
