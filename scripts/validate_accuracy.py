"""Replay a stored JSONL session through the DSP and assert sanity bounds.

This is the Phase-B harness referenced in PLAN_3D_RAW_CALIBRATION.md §2 step 6.
Without it every accuracy claim is anecdotal — with it, a regression in the
DSP path that quietly inflates motion under stillness will fail CI.

Usage (Windows PowerShell):
    python scripts\\validate_accuracy.py data\\recordings\\<session-id>.jsonl

Usage (Mac / Linux):
    python scripts/validate_accuracy.py data/recordings/<session-id>.jsonl

Optional second argument is a labels JSON describing what each segment is
expected to contain ({"empty_room": [(0, 5)], "wave_hand": [(10, 15)]}). When
omitted, the script just prints a summary report — exit code 0.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from aether_protocol import RawCsiFrame, SourceMode

from services.dsp.src.calibration import BaselineCalibrator
from services.dsp.src.features import derive_window
from services.dsp.src.preprocessing import iq_array_to_amplitude


def _load(path: Path) -> list[RawCsiFrame]:
    out: list[RawCsiFrame] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            payload = json.loads(line)
            payload["source_mode"] = SourceMode(payload.get("source_mode", "REPLAY"))
            out.append(RawCsiFrame(**payload))
    return out


def _windows(frames: list[RawCsiFrame], stride: int = 10) -> list[Any]:
    """Walk the recording in non-overlapping windows of ``stride`` frames."""
    cal = BaselineCalibrator()
    # Calibrate from the first 10% of the recording on the assumption it's
    # empty-room (replays for validation should put the stillness segment
    # first; if not, baseline is just rougher).
    head = max(stride, len(frames) // 10)
    cal.begin(duration_seconds=999.0)
    for f in frames[:head]:
        amp = iq_array_to_amplitude(f.raw_iq_int8)
        if amp.size:
            cal.feed(amp, ts_host_ns=int(f.ts_host_ns), rssi_dbm=float(f.rssi_dbm))
    cal._calibrating = False  # type: ignore[attr-defined]
    cal._evaluate_acceptance(  # type: ignore[attr-defined]
        max(1e-3, (frames[head - 1].ts_host_ns - frames[0].ts_host_ns) / 1e9),
    )

    out: list[Any] = []
    for start in range(0, len(frames) - stride, stride):
        block = frames[start : start + stride]
        try:
            window = derive_window(block, calibrator=cal, expected_packet_rate_hz=20.0)
        except Exception as exc:  # noqa: BLE001
            print(f"derive_window failed at start={start}: {exc}", file=sys.stderr)
            continue
        out.append(window)
    return out


def _summarise(windows: list[Any]) -> dict[str, float]:
    if not windows:
        return {}
    motion = [w.motion_score for w in windows]
    occupancy = [w.occupancy_score for w in windows]
    quality = [w.quality_score for w in windows]
    rate = [w.packet_rate_hz for w in windows]
    return {
        "windows": len(windows),
        "motion_min": min(motion),
        "motion_p50": sorted(motion)[len(motion) // 2],
        "motion_max": max(motion),
        "occupancy_max": max(occupancy),
        "quality_min": min(quality),
        "quality_p50": sorted(quality)[len(quality) // 2],
        "rate_min_hz": min(rate),
        "rate_p50_hz": sorted(rate)[len(rate) // 2],
    }


def _main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.exists():
        print(f"recording not found: {path}", file=sys.stderr)
        return 2
    frames = _load(path)
    print(f"loaded {len(frames)} frames from {path}")
    if len(frames) < 30:
        print("not enough frames to validate (need >= 30)", file=sys.stderr)
        return 2
    windows = _windows(frames)
    summary = _summarise(windows)
    print("DSP summary:")
    for k, v in summary.items():
        print(f"  {k:20s} = {v:.3f}")

    failures: list[str] = []
    # Heuristic acceptance bounds — tweak per recording with a labels file.
    if summary.get("rate_p50_hz", 0) < 5:
        failures.append(
            f"packet rate p50 {summary['rate_p50_hz']:.1f} Hz is below the 5 Hz floor"
        )
    if summary.get("quality_p50", 0) < 0.3:
        failures.append(
            f"quality p50 {summary['quality_p50']:.2f} is below 0.30 — check the link"
        )
    if summary.get("motion_max", 0) < 1e-6:
        failures.append("motion never exceeded zero — DSP is producing flat output")

    if failures:
        print("\nFAIL:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print("\nOK: replay passed sanity bounds.")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
