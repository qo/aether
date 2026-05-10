from __future__ import annotations

import logging
import time
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from aether_protocol import ExperimentEvent, RoomGeometry, SourceMode

from ..config import get_settings
from ..services.runtime import RuntimeState

logger = logging.getLogger(__name__)

# Indoor log-distance path-loss model at 2.4 GHz:
#     PL(d) = PL(1m) + 10 * n * log10(d_m)
# where PL(1m) ~= 40 dB at 2.4 GHz (free-space at 1 m) and n is the path-loss
# exponent. n=2 is free-space (outdoors LOS), n=3 is typical indoor with
# normal furniture, n=4 is heavy walls. We use n=3 as a one-size-fits-most
# default; rough calibration vs a tape measure is the operator's job.
# TX EIRP ~17 dBm assumes ESP32-S3 default with no external antenna gain.
#     RSSI(d) = P_tx - PL(d)  =>  d = 10 ^ ((P_tx - RSSI - PL(1m)) / (10 * n))
# Indoors this is a very rough number. ±50% is normal. Only useful as a
# sanity check vs an operator-measured distance, never as a measurement.
_TX_EFFECTIVE_DBM = 17.0
_PL_1M_DB = 40.0
_PL_EXPONENT = 3.0


def _rssi_implied_distance_m(rssi_dbm: float | None) -> float | None:
    if rssi_dbm is None:
        return None
    try:
        d = 10 ** (
            (_TX_EFFECTIVE_DBM - float(rssi_dbm) - _PL_1M_DB) / (10.0 * _PL_EXPONENT)
        )
    except (ValueError, OverflowError):
        return None
    # Clip to a plausible indoor range. RSSI < ~-95 dBm is at/below noise
    # floor and the model breaks down; refuse rather than hallucinate.
    if d <= 0.05 or d > 50.0:
        return None
    return float(round(d, 2))


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
        snap = state.link_stats.snapshot()
        # TX status: the TX firmware is transmit-only and does not phone home,
        # so we cannot positively confirm it's running. We can only report
        # whether the RX is *receiving* frames — that's the closest proxy.
        if snap.frames_seen > 0 and (
            snap.last_frame_age_s is None or snap.last_frame_age_s < 5.0
        ):
            tx_status = "presumed_emitting"  # RX is seeing CSI, so something is on-air
        else:
            tx_status = "no_rx_frames_yet"   # cannot confirm or deny
        # RX status: tied to whether the host is actually decoding frames,
        # not just whether the COM port string is set.
        if snap.frames_seen == 0:
            rx_status = "not_streaming" if settings.serial_port else "not_configured"
        elif snap.last_frame_age_s is None or snap.last_frame_age_s < 5.0:
            rx_status = "streaming"
        else:
            rx_status = "stalled"
        return {
            "source_mode": settings.source_mode,
            "tx": {
                "role": "esp32-s3-tx",
                "status": tx_status,
                # No serial port to surface — the TX board is power-only on this rig.
            },
            "rx": {
                "role": "esp32-s3-rx",
                "status": rx_status,
                "serial_port": settings.serial_port,
                "baud": settings.baud,
                "observed_packet_rate_hz": snap.observed_packet_rate_hz if snap.frames_seen > 0 else None,
                "expected_packet_rate_hz": snap.expected_packet_rate_hz,
                "expected_rate_source": state.expected_rate_source,
                "firmware_dropped": snap.firmware_dropped,
                "firmware_queue_depth": snap.firmware_queue_depth,
                "last_frame_age_s": snap.last_frame_age_s,
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

    @router.get("/sessions/{session_id}/frames")
    async def session_frames(
        session_id: str,
        from_ns: int | None = None,
        to_ns: int | None = None,
        limit: int = 200,
    ) -> dict[str, object]:
        """Page of raw CSI frames from the per-session JSONL.

        Used by the Raw Sensor tab. Capped at 2000 per request to avoid the
        full-session firehose being delivered as a single response.
        """
        try:
            state.store.get_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc
        capped = max(1, min(int(limit), 2000))
        frames = state.store.read_raw_frames(
            session_id, from_ns=from_ns, to_ns=to_ns, limit=capped
        )
        return {"session_id": session_id, "count": len(frames), "frames": frames}

    @router.get("/sessions/{session_id}/frames/latest")
    async def session_frames_latest(
        session_id: str, n: int = 50
    ) -> dict[str, object]:
        try:
            state.store.get_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="session not found") from exc
        capped = max(1, min(int(n), 500))
        frames = state.store.read_raw_frames(session_id, limit=capped, latest=True)
        return {"session_id": session_id, "count": len(frames), "frames": frames}

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

    @router.get("/diagnostics/link")
    async def diagnostics_link() -> dict[str, object]:
        """Live host-side link telemetry — observed Hz, jitter, drop counts.

        This is the Phase-A surface that turns 'the link feels slow' into
        an exact set of numbers operators can act on (and that the UI can
        display on the Raw Sensor / Diagnostics tab).
        """
        snap = state.link_stats.snapshot()
        # When no frames have been seen the observed_packet_rate_hz is by
        # definition zero — but we don't want clients to render "0.0 Hz" as
        # though that were a measurement. Surface None instead and let the UI
        # show "no frames yet".
        observed = snap.observed_packet_rate_hz if snap.frames_seen > 0 else None
        return {
            "schema_version": "link_diagnostics.v1",
            "observed_packet_rate_hz": observed,
            "expected_packet_rate_hz": snap.expected_packet_rate_hz,
            "expected_rate_source": state.expected_rate_source,
            "inter_arrival_p50_ms": snap.inter_arrival_p50_ms,
            "inter_arrival_p90_ms": snap.inter_arrival_p90_ms,
            "inter_arrival_p99_ms": snap.inter_arrival_p99_ms,
            "inter_arrival_max_ms": snap.inter_arrival_max_ms,
            "inter_arrival_jitter_ms": snap.inter_arrival_jitter_ms,
            "rssi_p50_dbm": snap.rssi_p50_dbm,
            "rssi_std_dbm": snap.rssi_std_dbm,
            "noise_floor_p50_dbm": snap.noise_floor_p50_dbm,
            "first_word_invalid_ratio": snap.first_word_invalid_ratio,
            "frames_seen": snap.frames_seen,
            "firmware_packets_seen": snap.firmware_packets_seen,
            "firmware_dropped": snap.firmware_dropped,
            "firmware_queue_depth": snap.firmware_queue_depth,
            "rate_stable": snap.rate_stable,
            "last_frame_age_s": snap.last_frame_age_s,
            # Free-space path-loss estimate of TX-RX distance from RSSI.
            # Rough — indoors multipath dominates. Only a sanity check.
            "rssi_implied_distance_m": _rssi_implied_distance_m(snap.rssi_p50_dbm),
            "notes": snap.notes,
        }

    @router.get("/room/geometry")
    async def get_room_geometry() -> dict[str, object]:
        """Operator-supplied room/TX/RX/subject geometry for the 3D view.

        All position fields are ``null`` until the operator has saved real
        measurements. ``is_complete`` is true once room + TX + RX are
        populated; subject is optional. The 3D view refuses to render
        until ``is_complete`` is true.
        """
        geometry = state.store.get_room_geometry()
        return {
            **geometry.model_dump(mode="json"),
            "is_complete": geometry.is_complete,
            "rssi_implied_distance_m": _rssi_implied_distance_m(
                state.link_stats.snapshot().rssi_p50_dbm
            ),
        }

    @router.put("/room/geometry")
    async def put_room_geometry(payload: RoomGeometry) -> dict[str, object]:
        saved = state.store.set_room_geometry(payload)
        logger.info(
            "[route] room geometry updated extent=%s tx=%s rx=%s subject=%s",
            saved.room_extent_m,
            saved.tx_position_m,
            saved.rx_position_m,
            saved.subject_position_m,
        )
        return {
            **saved.model_dump(mode="json"),
            "is_complete": saved.is_complete,
            "rssi_implied_distance_m": _rssi_implied_distance_m(
                state.link_stats.snapshot().rssi_p50_dbm
            ),
        }

    @router.get("/diagnostics/subcarriers")
    async def diagnostics_subcarriers() -> dict[str, object]:
        """Per-subcarrier baseline / SNR / responsive-set introspection.

        Returns the calibrator's internal view: which subcarriers we trust
        (high SNR), which the biorhythm path treats as 'responsive', and
        the per-subcarrier baseline mean / std. Empty until baseline calibration
        completes.
        """
        return state.subcarrier_diagnostics()

    return router
