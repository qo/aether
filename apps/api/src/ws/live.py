"""WebSocket handler for the /ws/live stream.

Lifecycle (and what the operator sees in logs):

    [ws] >> connect from <addr>
    [ws] hello sent (no derived window yet)        # before first DSP output
    [ws] sent N derived windows in 5.0 s (X /s)    # repeating every 5 s
    [ws] << disconnect from <addr> after T.s, sent=N

Topic model (Phase C):

    The default subscription is ["derived_window"], which preserves the V0
    behaviour. A client can opt into raw frames by sending:

        { "type": "subscribe", "topics": ["derived_window", "raw_frame"] }

    Raw frames are rate-limited server-side (max ~30 Hz) so a fast link
    cannot overrun a slow renderer. The full RawCsiFrame is sent verbatim
    along with cheap server-computed amplitude / phase arrays so the UI
    doesn't have to redo the I/Q math on every frame.

Why this much detail in logs? When the UI shows "offline" or "warming_up"
the most common questions are:

  - did the client even reach the server?         -> "connect from"
  - is the DSP producing windows?                 -> the periodic rate line
  - did the server kick the client?               -> the disconnect line +
                                                     reason
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from services.dsp.src.preprocessing import iq_array_to_amplitude, iq_array_to_phase

from ..services.runtime import RuntimeState

logger = logging.getLogger(__name__)

_RATE_WINDOW_SECONDS = 5.0
# Cap raw-frame fan-out to ~30 Hz per client even if the link is faster.
_RAW_FRAME_MIN_INTERVAL_S = 1.0 / 30.0


def _amp_phase_for(frame: Any) -> tuple[list[float], list[float]]:
    """Compute per-subcarrier amplitude/phase arrays for a raw frame.

    Cheap (vectorised) so we can do this per-message without burdening the
    DSP loop. Returns plain Python lists for direct JSON encoding.
    """
    raw = list(getattr(frame, "raw_iq_int8", []) or [])
    amp = iq_array_to_amplitude(raw)
    phase = iq_array_to_phase(raw)
    return amp.tolist(), phase.tolist()


async def live_websocket(websocket: WebSocket, state: RuntimeState) -> None:
    client = f"{websocket.client.host}:{websocket.client.port}" if websocket.client else "?"
    await websocket.accept()
    started = time.monotonic()
    sent = 0
    last_report_at = started
    last_report_count = 0
    topics: set[str] = {"derived_window"}
    last_raw_emit = 0.0
    logger.info("[ws] >> connect from %s", client)

    async def reader() -> None:
        """Background task that consumes client subscribe messages."""
        try:
            while True:
                text = await websocket.receive_text()
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    logger.debug("[ws] %s ignored non-JSON inbound: %r", client, text[:80])
                    continue
                if isinstance(msg, dict) and msg.get("type") == "subscribe":
                    new_topics = msg.get("topics") or []
                    if isinstance(new_topics, list):
                        topics.clear()
                        for t in new_topics:
                            if isinstance(t, str):
                                topics.add(t)
                        logger.info("[ws] %s subscribe topics=%s", client, sorted(topics))
                        await websocket.send_json(
                            {"type": "subscribed", "topics": sorted(topics)}
                        )
        except WebSocketDisconnect:
            return
        except Exception:  # noqa: BLE001 — keep the writer alive on any reader hiccup
            logger.debug("[ws] %s reader exited", client, exc_info=True)
            return

    reader_task = asyncio.create_task(reader())

    try:
        hello: dict[str, Any] = {
            "type": "hello",
            "summary": state.live_summary(),
            "available_topics": ["derived_window", "raw_frame"],
        }
        await websocket.send_json(hello)
        if state.latest_window is None:
            logger.info("[ws] %s hello sent (no derived window yet)", client)
        else:
            logger.info("[ws] %s hello sent (derived window available)", client)

        # Subscribe to both buses concurrently so raw and derived flow in
        # parallel rather than blocking each other. We use the
        # subscribe_with_handle path so backpressure drops are visible:
        # the per-subscriber `lag` counter increments whenever the bus
        # had to drop a queued item to make room. We forward that to the
        # client on the next derived_window so a slow tab can show a
        # "lagged N frames" hint instead of silently missing data.
        derived_iter, derived_handle = state.derived_bus.subscribe_with_handle()
        raw_iter, raw_handle = state.raw_bus.subscribe_with_handle()

        # Shared "we're done" flag. The first pump that sees a closed socket
        # flips this so the other stops trying to send. Without it, when one
        # send_json races with the close, the other keeps writing to a closed
        # connection and Starlette/uvicorn raise the noisy "ASGI send after
        # close" RuntimeError that filled the operator's log.
        closed = asyncio.Event()

        async def safe_send(payload: dict[str, Any]) -> bool:
            """Send a JSON payload; on disconnect, flip `closed` and return False.

            Callers must check the return value and break out of their loop.
            """
            if closed.is_set():
                return False
            try:
                await websocket.send_json(payload)
                return True
            except WebSocketDisconnect:
                closed.set()
                return False
            except RuntimeError:
                # Starlette raises RuntimeError("Cannot call send once the
                # connection has been closed") and uvicorn raises a similar
                # one for "ASGI send after close". Treat both as a clean
                # disconnect rather than crashing the handler.
                closed.set()
                return False

        async def pump_derived() -> None:
            nonlocal sent, last_report_at, last_report_count
            async for window in derived_iter:
                if closed.is_set():
                    break
                if "derived_window" not in topics:
                    continue
                lag = derived_handle.take_lag()
                payload: dict[str, Any] = {
                    "type": "derived_window",
                    "window": window.model_dump(mode="json"),
                    "summary": state.live_summary(),
                }
                if lag:
                    payload["lag"] = lag
                ok = await safe_send(payload)
                if not ok:
                    break
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

        async def pump_raw() -> None:
            nonlocal last_raw_emit
            async for frame in raw_iter:
                if closed.is_set():
                    break
                if "raw_frame" not in topics:
                    continue
                now = time.monotonic()
                if now - last_raw_emit < _RAW_FRAME_MIN_INTERVAL_S:
                    continue
                last_raw_emit = now
                amp, phase = _amp_phase_for(frame)
                lag = raw_handle.take_lag()
                payload: dict[str, Any] = {
                    "type": "raw_frame",
                    "frame": frame.model_dump(mode="json"),
                    "derived": {
                        "amplitude": amp,
                        "phase": phase,
                        "subcarrier_count": len(amp),
                    },
                }
                if lag:
                    payload["lag"] = lag
                ok = await safe_send(payload)
                if not ok:
                    break

        # return_exceptions=True so a hiccup in one pump (e.g. an unexpected
        # JSON-encoding error) cannot cancel the other mid-send and trigger
        # the ASGI race we are paid to avoid.
        await asyncio.gather(pump_derived(), pump_raw(), return_exceptions=True)
    except WebSocketDisconnect as exc:
        elapsed = time.monotonic() - started
        logger.info(
            "[ws] << disconnect from %s after %.1fs, sent=%d, code=%s",
            client,
            elapsed,
            sent,
            exc.code,
        )
    except Exception:
        elapsed = time.monotonic() - started
        logger.exception(
            "[ws] !! handler raised for %s after %.1fs, sent=%d",
            client,
            elapsed,
            sent,
        )
        raise
    finally:
        reader_task.cancel()
        try:
            await reader_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
