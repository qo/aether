from __future__ import annotations

import logging
import time
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from aether_protocol import ExperimentEvent, SourceMode

from ..config import get_settings
from ..services.runtime import RuntimeState

logger = logging.getLogger(__name__)


class SessionCreate(BaseModel):
    protocol: str = "empty_room_baseline"
    notes: str | None = None
    consent: str = "local_experimenter_recorded"


class EventCreate(BaseModel):
    event_type: str
    label: str | None = None
    notes: str | None = None
    metadata: dict[str, object] = {}


class CalibrationStart(BaseModel):
    duration_seconds: float = 10.0


def build_router(state: RuntimeState) -> APIRouter:
    router = APIRouter()

    @router.get("/devices")
    async def devices() -> dict[str, object]:
        settings = get_settings()
        return {
            "source_mode": settings.source_mode,
            "tx": {"role": "esp32-s3-tx", "status": "unknown_until_hardware_check"},
            "rx": {
                "role": "esp32-s3-rx",
                "status": "serial_configured" if settings.serial_port else "not_configured",
                "serial_port": settings.serial_port,
                "baud": settings.baud,
            },
            "host": {"api": "healthy"},
        }

    @router.post("/sessions")
    async def create_session(payload: SessionCreate) -> dict[str, object]:
        settings = get_settings()
        record = state.store.create_session(
            source_mode=settings.source_mode,
            protocol=payload.protocol,
            notes=payload.notes,
            consent=payload.consent,
        )
        logger.info(
            "[route] session created id=%s protocol=%s mode=%s",
            record.get("session_id"),
            payload.protocol,
            settings.source_mode,
        )
        return record

    @router.get("/sessions")
    async def list_sessions() -> list[dict[str, object]]:
        return state.store.list_sessions()

    @router.get("/sessions/{session_id}")
    async def get_session(session_id: str) -> dict[str, object]:
        try:
            return state.store.get_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc

    @router.post("/sessions/{session_id}/start")
    async def start_session(session_id: str) -> dict[str, object]:
        try:
            session = state.store.start_session(session_id)
        except KeyError as exc:
            logger.warning("[route] start_session: not found id=%s", session_id)
            raise HTTPException(status_code=404, detail="session not found") from exc
        settings = get_settings()
        logger.info(
            "[route] start_session id=%s mode=%s replay_path=%s serial_port=%s",
            session_id,
            settings.source_mode,
            settings.replay_path,
            settings.serial_port,
        )
        if settings.source_mode == SourceMode.REPLAY:
            if not settings.replay_path:
                logger.error("[route] start_session %s: REPLAY mode but AETHER_REPLAY_PATH unset", session_id)
                raise HTTPException(status_code=400, detail="AETHER_REPLAY_PATH is required for REPLAY mode")
            await state.start_replay(path=str(settings.replay_path))
        else:
            if not settings.serial_port:
                logger.error("[route] start_session %s: LIVE mode but AETHER_SERIAL_PORT unset", session_id)
                raise HTTPException(status_code=400, detail="AETHER_SERIAL_PORT is required for LIVE mode")
            await state.start_live(port=settings.serial_port, baud=settings.baud, session_id=session_id)
        return session

    @router.post("/sessions/{session_id}/stop")
    async def stop_session(session_id: str) -> dict[str, object]:
        logger.info("[route] stop_session id=%s", session_id)
        await state.stop()
        try:
            return state.store.stop_session(session_id)
        except KeyError as exc:
            logger.warning("[route] stop_session: not found id=%s", session_id)
            raise HTTPException(status_code=404, detail="session not found") from exc

    @router.post("/sessions/{session_id}/events")
    async def add_event(session_id: str, payload: EventCreate) -> dict[str, object]:
        settings = get_settings()
        try:
            state.store.get_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc
        event = ExperimentEvent(
            session_id=session_id,
            event_id=str(uuid4()),
            event_type=payload.event_type,  # type: ignore[arg-type]
            ts_host_ns=time.time_ns(),
            label=payload.label,
            notes=payload.notes,
            metadata=payload.metadata,
            source_mode=settings.source_mode,
        )
        state.store.append_event(event)
        logger.info(
            "[route] event session=%s type=%s label=%s",
            session_id,
            payload.event_type,
            payload.label,
        )
        return event.model_dump(mode="json")

    @router.get("/sessions/{session_id}/summary")
    async def session_summary(session_id: str) -> dict[str, object]:
        try:
            return state.store.summarize_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc

    @router.get("/sessions/{session_id}/export")
    async def export_session(session_id: str) -> dict[str, object]:
        try:
            path = state.store.export_session_report(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc
        return {"session_id": session_id, "report_path": str(path)}

    @router.get("/room/summary")
    async def room_summary() -> dict[str, object]:
        return state.live_summary()

    @router.get("/calibration/baseline")
    async def calibration_status() -> dict[str, object]:
        return state.calibration_status()

    @router.post("/calibration/baseline")
    async def calibration_start(payload: CalibrationStart) -> dict[str, object]:
        try:
            status = state.begin_calibration(duration_seconds=payload.duration_seconds)
            logger.info("[route] calibration begin duration=%.1fs", payload.duration_seconds)
            return status
        except RuntimeError as exc:
            logger.warning("[route] calibration begin rejected: %s", exc)
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.delete("/calibration/baseline")
    async def calibration_reset() -> dict[str, object]:
        logger.info("[route] calibration reset")
        return state.reset_calibration()

    @router.post("/calibration/baseline/cancel")
    async def calibration_cancel() -> dict[str, object]:
        logger.info("[route] calibration cancel")
        return state.cancel_calibration()

    return router
