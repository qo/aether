from __future__ import annotations

from aether_protocol import RawCsiFrame, SourceMode


def enforce_source_mode(frame: RawCsiFrame, expected: SourceMode) -> RawCsiFrame:
    if frame.source_mode != expected:
        raise ValueError(f"source mode mismatch: expected {expected}, got {frame.source_mode}")
    return frame
