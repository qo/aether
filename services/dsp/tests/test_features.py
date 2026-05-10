import json
from pathlib import Path

import pytest

from aether_protocol import RawCsiFrame
from services.dsp.src.features import derive_window
from services.dsp.src.preprocessing import raw_iq_to_complex


def test_raw_iq_to_complex():
    assert raw_iq_to_complex([1, 2, -3, 4]) == [complex(1, 2), complex(-3, 4)]


def test_derive_window_from_hardware_fixture():
    fixture = Path("data/fixtures/live_csi_sample.jsonl")
    if not fixture.exists():
        pytest.skip("requires a recorded live hardware fixture at data/fixtures/live_csi_sample.jsonl")
    frames = [
        RawCsiFrame(**json.loads(line))
        for line in fixture.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ][:12]
    window = derive_window(frames)
    assert window.schema_version == "derived_window.v1"
    assert window.packet_count == len(frames)
    assert window.subcarrier_count > 0
    assert 0 <= window.quality_score <= 1
