"""Probe a list of serial ports and report which one emits Aether CSI lines.

Used by `setup_local.ps1` to auto-detect which COM port is the RX board so
the operator does not have to guess. Output is line-oriented JSON so a shell
caller can parse the result. Errors are also JSON so nothing is ever silent.

For each port we:
  - try to open at 115200 8N1 with a 1.5 s read timeout
  - read for up to PROBE_SECONDS, looking for any line that parses as CSI
    via the same parser the runtime uses (services.collector.src.parser)
  - emit one summary line per port: {port, opened, csi, heartbeat, sample}
"""

from __future__ import annotations

import json
import sys
import time

PROBE_SECONDS = 4.0
BAUD = 115200


def probe(port: str) -> dict[str, object]:
    result: dict[str, object] = {
        "port": port,
        "opened": False,
        "csi": 0,
        "heartbeat": 0,
        "other_lines": 0,
        "sample": None,
        "error": None,
    }
    try:
        import serial  # type: ignore
    except ImportError as exc:
        result["error"] = f"pyserial missing: {exc}"
        return result

    try:
        sp = serial.Serial(port, BAUD, timeout=1.0)
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"open failed: {exc}"
        return result
    result["opened"] = True

    # Use the project's own parser so a "csi" line here is exactly what the
    # runtime would accept. We keep parser failures quiet because the boards
    # also emit ESP-IDF boot logs while warming up.
    try:
        from services.collector.src.parser import SerialParseError, parse_serial_line
        from aether_protocol import SourceMode  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"import parser failed: {exc}"
        try:
            sp.close()
        except Exception:  # noqa: BLE001
            pass
        return result

    deadline = time.monotonic() + PROBE_SECONDS
    sample = None
    try:
        while time.monotonic() < deadline:
            line = sp.readline()
            if not line:
                continue
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            if sample is None:
                sample = text[:160]
            try:
                msg = parse_serial_line(line, session_id="probe", source_mode="REPLAY")  # type: ignore[arg-type]
                if msg.message_type == "csi":
                    result["csi"] = int(result["csi"]) + 1
                elif msg.message_type == "heartbeat":
                    result["heartbeat"] = int(result["heartbeat"]) + 1
                else:
                    result["other_lines"] = int(result["other_lines"]) + 1
            except SerialParseError:
                result["other_lines"] = int(result["other_lines"]) + 1
    finally:
        try:
            sp.close()
        except Exception:  # noqa: BLE001
            pass

    result["sample"] = sample
    return result


def main() -> int:
    ports = sys.argv[1:]
    if not ports:
        sys.stderr.write("usage: probe_serial.py COM9 COM10 ...\n")
        return 2
    for p in ports:
        print(json.dumps(probe(p)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
