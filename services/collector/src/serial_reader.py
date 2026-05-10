from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from aether_protocol import RawCsiFrame, SourceMode

from .parser import SerialParseError, parse_serial_line

logger = logging.getLogger(__name__)

# If readline returns nothing for this many seconds we treat the link as dead
# and tear the serial port down for a reconnect cycle.
READ_STALL_SECONDS = 10.0
INITIAL_RETRY_SECONDS = 1.0
MAX_RETRY_SECONDS = 30.0


async def read_serial_frames(
    *,
    port: str,
    baud: int,
    session_id: str,
) -> AsyncIterator[RawCsiFrame | dict[str, Any]]:
    """Yield CSI frames AND firmware envelopes from a serial port.

    Each yielded value is either a ``RawCsiFrame`` (for ``type=csi`` lines) or
    a ``dict`` (for ``type=heartbeat`` and ``type=status`` lines). Callers
    must isinstance-dispatch — this lets the runtime feed the heartbeat
    counters into LinkStats without a second reader path.

    Wraps pyserial in a watchdog/backoff loop. Three failure modes are handled:

      - serial.SerialException on open       -> exponential backoff and retry
      - readline timeout (no bytes for N s)  -> close, backoff, reopen
      - JSON parse errors                    -> logged, frame skipped

    The async iterator never raises in steady state. Callers can stop the
    consumer by cancelling the surrounding task.
    """
    try:
        import serial  # type: ignore
    except ImportError as exc:
        raise RuntimeError("pyserial is required for LIVE mode") from exc

    backoff = INITIAL_RETRY_SECONDS

    while True:
        serial_port = None
        try:
            serial_port = await asyncio.to_thread(
                serial.Serial, port, baud, timeout=1
            )
            logger.info("serial open port=%s baud=%d session=%s", port, baud, session_id)
            backoff = INITIAL_RETRY_SECONDS
            last_byte_at = time.monotonic()

            while True:
                line = await asyncio.to_thread(serial_port.readline)
                now = time.monotonic()

                if not line:
                    if now - last_byte_at > READ_STALL_SECONDS:
                        logger.warning(
                            "serial stall: no bytes for %.1fs; reconnecting", READ_STALL_SECONDS
                        )
                        break
                    await asyncio.sleep(0.01)
                    continue

                last_byte_at = now
                try:
                    message = parse_serial_line(
                        line, session_id=session_id, source_mode=SourceMode.LIVE
                    )
                except SerialParseError as exc:
                    logger.debug("skip non-CSI serial line: %s", exc)
                    continue
                if message.message_type == "csi":
                    yield message.payload  # type: ignore[misc]
                elif message.message_type == "heartbeat":
                    # Firmware heartbeat envelope -> let the runtime route it
                    # into LinkStats so we get queue / drop telemetry surfaced.
                    yield message.payload  # type: ignore[misc]

        except serial.SerialException as exc:  # type: ignore[attr-defined]
            logger.warning("serial port error on %s: %s; retry in %.1fs", port, exc, backoff)
            # Yield an error envelope so the runtime can surface this in the
            # /devices payload. Without it, a misconfigured COM port produces
            # log spam but a silent UI ("no frames yet" forever).
            yield {
                "type": "source_error",
                "kind": "serial_exception",
                "error": str(exc),
                "port": port,
                "retry_in_s": backoff,
            }
        except OSError as exc:
            logger.warning("serial OSError on %s: %s; retry in %.1fs", port, exc, backoff)
            yield {
                "type": "source_error",
                "kind": "os_error",
                "error": str(exc),
                "port": port,
                "retry_in_s": backoff,
            }
        finally:
            if serial_port is not None:
                try:
                    await asyncio.to_thread(serial_port.close)
                except Exception:  # noqa: BLE001
                    pass
                logger.info("serial closed port=%s", port)

        await asyncio.sleep(backoff)
        backoff = min(MAX_RETRY_SECONDS, backoff * 2)
