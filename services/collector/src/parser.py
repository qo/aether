from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Literal

from aether_protocol import RawCsiFrame, SourceMode


@dataclass(frozen=True)
class ParsedSerialMessage:
    message_type: Literal["csi", "status", "heartbeat"]
    payload: dict[str, Any] | RawCsiFrame


class SerialParseError(ValueError):
    pass


def parse_serial_line(
    line: bytes | str,
    *,
    session_id: str,
    source_mode: SourceMode = SourceMode.LIVE,
) -> ParsedSerialMessage:
    text = line.decode("utf-8", errors="replace").strip() if isinstance(line, bytes) else line.strip()
    if not text:
        raise SerialParseError("empty serial line")

    try:
        envelope = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SerialParseError(f"invalid JSON serial line: {exc}") from exc

    if not isinstance(envelope, dict):
        raise SerialParseError("serial line must decode to an object")

    message_type = envelope.get("type")
    if message_type not in {"csi", "status", "heartbeat"}:
        raise SerialParseError(f"unknown serial message type: {message_type!r}")

    if message_type in {"status", "heartbeat"}:
        return ParsedSerialMessage(message_type=message_type, payload=envelope)

    payload = envelope.get("payload", envelope)
    if not isinstance(payload, dict):
        raise SerialParseError("csi payload must be an object")

    raw_iq = payload.get("raw_iq_int8", payload.get("data", []))
    frame = RawCsiFrame(
        schema_version="csi_frame.v1",
        session_id=str(payload.get("session_id") or session_id),
        device_id=str(payload.get("device_id") or envelope.get("device_id") or "esp32-s3-rx"),
        device_role="rx",
        seq=int(payload.get("seq", 0)),
        ts_device_us=int(payload.get("ts_device_us", payload.get("timestamp", 0))),
        ts_host_ns=int(payload.get("ts_host_ns", time.time_ns())),
        channel=int(payload.get("channel", envelope.get("channel", 6))),
        rssi_dbm=int(payload.get("rssi_dbm", payload.get("rssi", -127))),
        noise_floor_dbm=int(payload.get("noise_floor_dbm", payload.get("noise_floor", -95))),
        sig_mode=int(payload.get("sig_mode", 0)),
        cwb=int(payload.get("cwb", 0)),
        secondary_channel=int(payload.get("secondary_channel", 0)),
        stbc=int(payload.get("stbc", 0)),
        first_word_invalid=bool(payload.get("first_word_invalid", False)),
        payload_len=int(payload.get("payload_len", len(raw_iq))),
        raw_iq_int8=[int(v) for v in raw_iq],
        source_mode=source_mode,
    )
    return ParsedSerialMessage(message_type="csi", payload=frame)
