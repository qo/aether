from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field

from aether_protocol import DerivedWindow, RawCsiFrame
from services.collector.src.publisher import InMemoryEventBus
from services.collector.src.replay import replay_jsonl
from services.collector.src.serial_reader import read_serial_frames
from services.dsp.src.biorhythm import BiorhythmEstimator
from services.dsp.src.calibration import BaselineCalibrator
from services.dsp.src.features import derive_window
from services.dsp.src.preprocessing import iq_array_to_amplitude
from services.dsp.src.summaries import room_summary

from .link_stats import LinkStats
from .session_store import SessionStore

logger = logging.getLogger(__name__)

# Default expected packet rate from a healthy two-board ESP32-S3 link with the
# bundled TX firmware (50 ms cadence -> ~20 Hz CSI callbacks at the receiver).
# Used until LinkStats reports a stable observed rate, at which point the
# observed value takes over for quality scoring (see _maybe_adopt_observed_rate).
DEFAULT_EXPECTED_PACKET_RATE_HZ = 20.0


@dataclass
class RuntimeState:
    store: SessionStore
    raw_bus: InMemoryEventBus[RawCsiFrame] = field(default_factory=InMemoryEventBus)
    derived_bus: InMemoryEventBus[DerivedWindow] = field(default_factory=InMemoryEventBus)
    latest_raw: RawCsiFrame | None = None
    latest_window: DerivedWindow | None = None
    source_task: asyncio.Task[None] | None = None
    active_session_id: str | None = None
    running: bool = False
    expected_packet_rate_hz: float = DEFAULT_EXPECTED_PACKET_RATE_HZ
    expected_rate_source: str = "default"
    last_frame_ts_host_ns: int = 0
    # Set whenever the live source task fails to open or read the serial port.
    # Cleared on successful frame ingest. Surfaced via /devices.rx.last_error
    # so the UI can show "why" no frames are flowing.
    last_source_error: str | None = None
    last_source_error_kind: str | None = None
    last_source_error_at_ns: int = 0
    _frames_seen: int = 0
    _windows_emitted: int = 0
    _window_frames: deque[RawCsiFrame] = field(default_factory=lambda: deque(maxlen=40))
    _biorhythm: BiorhythmEstimator = field(default_factory=BiorhythmEstimator)
    _calibrator: BaselineCalibrator = field(default_factory=BaselineCalibrator)
    _calibration_was_accepted: bool = False
    link_stats: LinkStats = field(default_factory=LinkStats)

    def __post_init__(self) -> None:
        # Restore previously-captured calibration baseline from the store
        # (item 8.2). Without this, every API restart loses the 10-30 s of
        # baseline capture work — bad operator workflow. The persisted
        # snapshot includes the Welford state so the restored calibrator
        # behaves identically to one that just finished its own capture.
        try:
            stored = self.store.get_calibration()
        except Exception:  # noqa: BLE001 — corrupted row is non-fatal
            stored = None
        if stored is not None:
            _stage, payload = stored
            self._calibrator = BaselineCalibrator.from_persisted_dict(payload)
            self._calibration_was_accepted = self._calibrator.is_calibrated
            if self._calibrator.is_calibrated:
                logger.info(
                    "[runtime] restored calibration baseline from store: "
                    "subcarriers=%d frames=%d",
                    self._calibrator.snapshot().subcarrier_count if self._calibrator.snapshot() else 0,
                    self._calibrator.frames_observed,
                )

    async def publish_frame(self, frame: RawCsiFrame) -> None:
        self.latest_raw = frame
        self.last_frame_ts_host_ns = int(frame.ts_host_ns)
        self._window_frames.append(frame)
        self.store.append_raw_frame(frame)
        self._frames_seen += 1
        # First successful frame after a serial-open failure clears the
        # sticky error so the UI doesn't keep claiming the port is broken
        # once it actually reconnected.
        if self.last_source_error is not None:
            self.last_source_error = None
            self.last_source_error_kind = None
            self.last_source_error_at_ns = 0
        # Phase A: feed link diagnostics (jitter, observed Hz, RSSI std).
        self.link_stats.record_frame(
            ts_host_ns=int(frame.ts_host_ns),
            rssi_dbm=int(frame.rssi_dbm),
            noise_floor_dbm=int(frame.noise_floor_dbm),
            first_word_invalid=bool(frame.first_word_invalid),
        )
        self._maybe_adopt_observed_rate()

        # Heartbeat: every 100 frames, prove the collector is alive without
        # spamming a line per packet at 20 Hz. Includes derived-window count
        # so you can confirm the DSP stage is keeping up.
        if self._frames_seen % 100 == 0:
            snap = self.link_stats.snapshot()
            logger.info(
                "[runtime] collector heartbeat: frames=%d windows=%d buffered=%d "
                "obs_hz=%.2f exp_hz=%.2f p50ms=%s p99ms=%s drops=%s",
                self._frames_seen,
                self._windows_emitted,
                len(self._window_frames),
                snap.observed_packet_rate_hz,
                self.expected_packet_rate_hz,
                f"{snap.inter_arrival_p50_ms:.1f}" if snap.inter_arrival_p50_ms else "-",
                f"{snap.inter_arrival_p99_ms:.1f}" if snap.inter_arrival_p99_ms else "-",
                snap.firmware_dropped if snap.firmware_dropped is not None else "-",
            )

        # Calibration: feed per-frame amplitude vector into the baseline accumulator.
        # Also pass RSSI + last-known motion so the calibrator can reject
        # baselines captured during noisy/active windows (Phase B acceptance).
        # Post-calibration: feed "still" frames into the drift EWMA so the
        # operator gets a heads-up when thermal/AGC drift has invalidated
        # the baseline (item 8.3).
        if self._calibrator.is_calibrated and not self._calibrator.is_calibrating:
            last_motion = self.latest_window.motion_score if self.latest_window else None
            if last_motion is not None and last_motion < 1.5:
                amp = iq_array_to_amplitude(frame.raw_iq_int8)
                if amp.size > 0:
                    self._calibrator.feed_idle_amplitude(amp)
        if self._calibrator.is_calibrating:
            amp = iq_array_to_amplitude(frame.raw_iq_int8)
            if amp.size > 0:
                last_motion = (
                    self.latest_window.motion_score if self.latest_window else None
                )
                completed = self._calibrator.feed(
                    amp,
                    ts_host_ns=int(frame.ts_host_ns),
                    rssi_dbm=float(frame.rssi_dbm),
                    motion_score=last_motion,
                )
                # Persist the moment a baseline accepts (item 8.2). Reject
                # cases stay in-memory so the operator can see the rejection
                # reason; only accepted baselines write to disk.
                if completed and self._calibrator.is_calibrated and not self._calibration_was_accepted:
                    payload = self._calibrator.to_persisted_dict()
                    if payload is not None:
                        try:
                            self.store.set_calibration(stage="still", payload=payload)
                            logger.info(
                                "[runtime] persisted calibration baseline (frames=%d)",
                                self._calibrator.frames_observed,
                            )
                        except Exception:  # noqa: BLE001
                            logger.exception("[runtime] persist calibration failed")
                    self._calibration_was_accepted = True

        # Bio rhythm wants to know whether the subject is still and whether we
        # have an empty-room baseline so it can apply the stillness gate.
        prev_motion = self.latest_window.motion_score if self.latest_window else None
        prev_calibrated = self.latest_window.baseline_calibrated if self.latest_window else False
        reading = self._biorhythm.update(
            frame,
            motion_score=prev_motion,
            baseline_calibrated=prev_calibrated,
        )
        await self.raw_bus.publish(frame)

        if len(self._window_frames) >= 10:
            window = derive_window(
                list(self._window_frames),
                calibrator=self._calibrator,
                expected_packet_rate_hz=self.expected_packet_rate_hz,
            )
            window.respiration_bpm = reading.respiration_bpm
            window.respiration_confidence = reading.respiration_confidence
            window.respiration_bpm_acf = reading.respiration_bpm_acf
            window.respiration_harmonic_prominence = reading.respiration_harmonic_prominence
            window.respiration_tracked_bpm = reading.respiration_tracked_bpm
            window.heart_rate_proxy_bpm = reading.heart_rate_proxy_bpm
            window.heart_rate_proxy_confidence = reading.heart_rate_proxy_confidence
            window.heart_rate_proxy_bpm_acf = reading.heart_rate_proxy_bpm_acf
            window.heart_rate_proxy_harmonic_prominence = (
                reading.heart_rate_proxy_harmonic_prominence
            )
            window.heart_rate_proxy_tracked_bpm = reading.heart_rate_proxy_tracked_bpm
            window.fidget_score = reading.fidget_score
            window.gait_score = reading.gait_score
            window.gait_steps_per_min = reading.gait_steps_per_min
            window.biorhythm_window_seconds = reading.window_seconds
            window.biorhythm_sample_rate_hz = reading.sample_rate_hz
            window.biorhythm_signal_path = reading.signal_path
            window.stillness_gated = reading.stillness_gated
            window.looks_like_respiration_harmonic = reading.looks_like_respiration_harmonic
            self.latest_window = window
            self.store.append_derived_window(window)
            await self.derived_bus.publish(window)
            self._windows_emitted += 1
            if self._windows_emitted % 50 == 0:
                logger.info(
                    "[runtime] dsp heartbeat: windows=%d motion=%.2f occupancy=%.2f quality=%.2f",
                    self._windows_emitted,
                    window.motion_score,
                    window.occupancy_score,
                    window.quality_score,
                )

    def live_summary(self) -> dict[str, object]:
        if self.latest_window is None:
            return {
                "schema_version": "room_summary.v1",
                "status": "warming_up",
                "confidence": 0.0,
                "unknowns": ["no derived window has been produced yet"],
                "calibration": self._calibrator.status(),
            }
        summary = room_summary(self.latest_window)
        summary["calibration"] = self._calibrator.status()
        return summary

    def calibration_status(self) -> dict[str, object]:
        return self._calibrator.status()

    def subcarrier_diagnostics(self) -> dict[str, object]:
        snap = self._calibrator.snapshot()
        if snap is None:
            return {
                "schema_version": "subcarrier_diagnostics.v1",
                "is_calibrated": False,
                "subcarrier_count": 0,
                "edges_dropped": 0,
                "amplitude_mean": [],
                "amplitude_std": [],
                "snr_weights": [],
                "responsive_indices": [],
            }
        # Mirror the edge-drop logic that derive_window applies so the UI
        # can highlight which subcarriers are "in play" vs trimmed by edge
        # filtering.
        from services.dsp.src.preprocessing import drop_edge_subcarriers
        import numpy as np

        full = np.array(snap.amplitude_mean, dtype=np.float64).reshape(1, -1)
        if full.size:
            _, kept = drop_edge_subcarriers(full, edge_fraction=0.06)
            kept_list = kept.tolist()
            edges = snap.subcarrier_count - len(kept_list)
        else:
            kept_list = []
            edges = 0
        responsive = self._calibrator.select_responsive_subcarriers(
            np.array(snap.amplitude_std, dtype=np.float64),
            top_k=8,
        ).tolist()
        return {
            "schema_version": "subcarrier_diagnostics.v1",
            "is_calibrated": True,
            "subcarrier_count": snap.subcarrier_count,
            "edges_dropped": int(edges),
            "kept_indices": kept_list,
            "responsive_indices": responsive,
            "amplitude_mean": snap.amplitude_mean,
            "amplitude_std": snap.amplitude_std,
            "snr_weights": snap.snr_weights,
        }

    def begin_calibration(self, *, duration_seconds: float = 10.0) -> dict[str, object]:
        if self.latest_raw is None:
            raise RuntimeError("no live frames yet; cannot calibrate")
        self._calibrator.begin(duration_seconds=duration_seconds)
        logger.info("baseline calibration started duration=%.1fs", duration_seconds)
        return self._calibrator.status()

    def cancel_calibration(self) -> dict[str, object]:
        self._calibrator.cancel()
        return self._calibrator.status()

    def reset_calibration(self) -> dict[str, object]:
        self._calibrator = BaselineCalibrator()
        self._calibration_was_accepted = False
        # Clear the persisted baseline too; otherwise a restart would
        # silently restore the old one and the operator's reset wouldn't
        # stick across processes.
        try:
            self.store.clear_calibration()
        except Exception:  # noqa: BLE001
            logger.exception("[runtime] clear_calibration failed")
        return self._calibrator.status()

    def record_firmware_heartbeat(
        self,
        *,
        packets_seen: int | None = None,
        dropped: int | None = None,
        queue_depth: int | None = None,
    ) -> None:
        """Push firmware-side counters from a heartbeat envelope into LinkStats."""
        self.link_stats.record_heartbeat(
            packets_seen=packets_seen,
            dropped=dropped,
            queue_depth=queue_depth,
        )

    def _maybe_adopt_observed_rate(self) -> None:
        """Switch from the default 20 Hz expectation to the measured value
        once LinkStats has a stable EMA. Idempotent.

        Why: until this fires, ``quality_score`` penalises every frame against
        an expected_packet_rate_hz that the hardware may not actually deliver.
        Adopting the observed rate removes that systematic bias.
        """
        if self.expected_rate_source == "observed":
            return
        if not self.link_stats.is_rate_stable():
            return
        observed = self.link_stats.observed_rate_hz()
        if observed <= 0.5:
            return
        previous = self.expected_packet_rate_hz
        self.expected_packet_rate_hz = float(observed)
        self.expected_rate_source = "observed"
        logger.info(
            "[runtime] adopted observed packet rate: was %.2f Hz (default), now %.2f Hz (measured)",
            previous,
            observed,
        )

    async def start_replay(self, *, path: str, packet_rate_hz: float = 20.0) -> None:
        if self.source_task and not self.source_task.done():
            logger.warning("[runtime] start_replay ignored: source task already running")
            return
        self.running = True
        self.expected_packet_rate_hz = packet_rate_hz
        self.expected_rate_source = "replay_configured"
        self.link_stats.reset()
        self._biorhythm.reset()
        self._frames_seen = 0
        self._windows_emitted = 0
        logger.info("[runtime] start_replay path=%s rate=%.1fHz", path, packet_rate_hz)

        async def run() -> None:
            while self.running:
                for frame in replay_jsonl(path):
                    if not self.running:
                        break
                    await self.publish_frame(frame)
                    await asyncio.sleep(1 / packet_rate_hz)
                self.running = False

        self.source_task = asyncio.create_task(run())

    async def start_live(self, *, port: str, baud: int, session_id: str) -> None:
        if self.source_task and not self.source_task.done():
            logger.warning("[runtime] start_live ignored: source task already running")
            return
        self.running = True
        self.active_session_id = session_id
        self.expected_packet_rate_hz = DEFAULT_EXPECTED_PACKET_RATE_HZ
        self.expected_rate_source = "default"
        self.link_stats.reset()
        self._biorhythm.reset()
        self._frames_seen = 0
        self._windows_emitted = 0
        logger.info("[runtime] start_live port=%s baud=%d session=%s", port, baud, session_id)

        async def run() -> None:
            try:
                async for message in read_serial_frames(port=port, baud=baud, session_id=session_id):
                    if not self.running:
                        break
                    if isinstance(message, RawCsiFrame):
                        await self.publish_frame(message)
                    elif isinstance(message, dict) and message.get("type") == "heartbeat":
                        # Phase A: firmware-side counters surfaced to LinkStats.
                        self.record_firmware_heartbeat(
                            packets_seen=message.get("packets_seen"),
                            dropped=message.get("dropped"),
                            queue_depth=message.get("queue_depth"),
                        )
                    elif isinstance(message, dict) and message.get("type") == "source_error":
                        # Source error: capture so /devices can surface "why".
                        # The reader keeps retrying internally, so this is a
                        # status, not a fatal — we don't break the loop.
                        self.last_source_error = str(message.get("error", ""))
                        self.last_source_error_kind = str(message.get("kind", "unknown"))
                        self.last_source_error_at_ns = time.time_ns()
            except Exception:
                logger.exception("live source task failed (port=%s)", port)
                self.running = False
                raise

        self.source_task = asyncio.create_task(run())

    async def stop(self) -> None:
        was_running = self.running
        self.running = False
        if self.source_task:
            self.source_task.cancel()
            try:
                await self.source_task
            except asyncio.CancelledError:
                pass
            self.source_task = None
        if was_running:
            logger.info(
                "[runtime] stopped after frames=%d windows=%d",
                self._frames_seen,
                self._windows_emitted,
            )
