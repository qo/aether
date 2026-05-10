"""WebSocket handler for the /ws/live stream.

Lifecycle (and what the operator sees in logs):

    [ws] >> connect from <addr>
    [ws] hello sent (no derived window yet)        # before first DSP output
    [ws] sent N derived windows in 5.0 s (X /s)    # repeating every 5 s
    [ws] << disconnect from <addr> after T.s, sent=N

Why this much detail? When the UI shows "offline" or "warming_up" the most
common questions are:
  - did the client even reach the server?         -> "connect from"
  - is the DSP producing windows?                 -> the periodic rate line
  - did the server kick the client?               -> the disconnect line +
                                                     reason
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from ..services.runtime import RuntimeState

logger = logging.getLogger(__name__)

_RATE_WINDOW_SECONDS = 5.0


async def live_websocket(websocket: WebSocket, state: RuntimeState) -> None:
    client = f"{websocket.client.host}:{websocket.client.port}" if websocket.client else "?"
    await websocket.accept()
    started = time.monotonic()
    sent = 0
    last_report_at = started
    last_report_count = 0
    logger.info("[ws] >> connect from %s", client)

    try:
        hello: dict[str, Any] = {"type": "hello", "summary": state.live_summary()}
        await websocket.send_json(hello)
        if state.latest_window is None:
            logger.info("[ws] %s hello sent (no derived window yet)", client)
        else:
            logger.info("[ws] %s hello sent (derived window available)", client)

        async for window in state.derived_bus.subscribe():
            await websocket.send_json(
                {
                    "type": "derived_window",
                    "window": window.model_dump(mode="json"),
                    "summary": state.live_summary(),
                }
            )
            sent += 1
            now = time.monotonic()
            if now - last_report_at >= _RATE_WINDOW_SECONDS:
                count = sent - last_report_count
                rate = count / (now - last_report_at)
                logger.info(
                    "[ws] %s sent %d derived windows in %.1fs (%.1f /s)",
                    client,
                    count,
                    now - last_report_at,
                    rate,
                )
                last_report_at = now
                last_report_count = sent
    except WebSocketDisconnect as exc:
        elapsed = time.monotonic() - started
        logger.info(
            "[ws] << disconnect from %s after %.1fs, sent=%d, code=%s",
            client,
            elapsed,
            sent,
            exc.code,
        )
        return
    except Exception:
        elapsed = time.monotonic() - started
        logger.exception(
            "[ws] !! handler raised for %s after %.1fs, sent=%d",
            client,
            elapsed,
            sent,
        )
        raise
