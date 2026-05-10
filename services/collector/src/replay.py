from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

from aether_protocol import RawCsiFrame, SourceMode


def replay_jsonl(path: str | Path, *, source_mode: SourceMode = SourceMode.REPLAY) -> Iterator[RawCsiFrame]:
    recording_path = Path(path)
    with recording_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            payload = json.loads(line)
            payload["source_mode"] = source_mode
            yield RawCsiFrame(**payload)
