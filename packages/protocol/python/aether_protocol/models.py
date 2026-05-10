from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SourceMode(StrEnum):
    LIVE = "LIVE"
    REPLAY = "REPLAY"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RawCsiFrame(StrictModel):
    schema_version: Literal["csi_frame.v1"] = "csi_frame.v1"
    session_id: str
    device_id: str
    device_role: Literal["rx"] = "rx"
    seq: int = Field(ge=0)
    ts_device_us: int = Field(ge=0)
    ts_host_ns: int = Field(ge=0)
    channel: int = Field(ge=1, le=14)
    rssi_dbm: int = Field(ge=-127, le=20)
    noise_floor_dbm: int = Field(ge=-127, le=20)
    sig_mode: int
    cwb: int
    secondary_channel: int
    stbc: int
    first_word_invalid: bool
    payload_len: int = Field(ge=0)
    raw_iq_int8: list[int]
    source_mode: SourceMode

    @field_validator("raw_iq_int8")
    @classmethod
    def validate_iq_int8(cls, values: list[int]) -> list[int]:
        for value in values:
            if value < -128 or value > 127:
                raise ValueError("raw_iq_int8 values must be signed int8")
        return values


class DerivedWindow(StrictModel):
    schema_version: Literal["derived_window.v1"] = "derived_window.v1"
    session_id: str
    device_id: str
    window_start_ns: int = Field(ge=0)
    window_end_ns: int = Field(ge=0)
    packet_count: int = Field(ge=0)
    packet_rate_hz: float = Field(ge=0)
    mean_rssi_dbm: float
    subcarrier_count: int = Field(ge=0)
    amplitude_mean: list[float]
    amplitude_std: list[float]
    phase_unwrapped_mean: list[float]
    # Phase B: per-subcarrier phase std across the window. Body motion shows
    # up here as well as in amplitude_std and is used as a secondary motion
    # axis in the score below. Optional for back-compat.
    phase_unwrapped_std: list[float] | None = None
    # Phase B: motion_score is the headline number; motion_score_amplitude
    # and motion_score_phase break it out by source so the UI/operator can
    # tell whether motion was driven by amplitude or phase wobble.
    motion_score_amplitude: float | None = Field(default=None, ge=0)
    motion_score_phase: float | None = Field(default=None, ge=0)
    # Phase B: indices (relative to subcarrier_count, after edge-trim) of
    # the responsive subset the calibrator selected. Empty until baseline.
    responsive_subcarriers: list[int] = Field(default_factory=list)
    motion_score: float = Field(ge=0)
    occupancy_score: float = Field(ge=0, le=1)
    respiration_bpm: float | None = None
    respiration_confidence: float | None = Field(default=None, ge=0, le=1)
    respiration_bpm_acf: float | None = Field(default=None, ge=0)
    respiration_harmonic_prominence: float | None = None
    respiration_tracked_bpm: float | None = Field(default=None, ge=0)
    heart_rate_proxy_bpm: float | None = None
    heart_rate_proxy_confidence: float | None = Field(default=None, ge=0, le=1)
    heart_rate_proxy_bpm_acf: float | None = Field(default=None, ge=0)
    heart_rate_proxy_harmonic_prominence: float | None = None
    heart_rate_proxy_tracked_bpm: float | None = Field(default=None, ge=0)
    fidget_score: float | None = Field(default=None, ge=0, le=1)
    # Walking-cadence band 1.5-3 Hz (typical step rate). gait_score is the
    # fraction of total motion-band energy in this band; gait_steps_per_min
    # is the spectral peak frequency expressed as steps/minute. Both are
    # [Inference] — CSI sees motion, not feet — but a sustained peak in
    # 1.5-3 Hz with low respiration energy is the cleanest CSI signature
    # of a person walking through the link. Optional for back-compat with
    # older replays.
    gait_score: float | None = Field(default=None, ge=0, le=1)
    gait_steps_per_min: float | None = Field(default=None, ge=0)
    biorhythm_window_seconds: float | None = Field(default=None, ge=0)
    biorhythm_sample_rate_hz: float | None = Field(default=None, ge=0)
    biorhythm_signal_path: str | None = None
    stillness_gated: bool = False
    looks_like_respiration_harmonic: bool = False
    anomaly_score: float = Field(ge=0)
    quality_score: float = Field(ge=0, le=1)
    packet_loss_ratio: float | None = Field(default=None, ge=0, le=1)
    first_word_invalid_ratio: float | None = Field(default=None, ge=0, le=1)
    jitter_ms: float | None = Field(default=None, ge=0)
    expected_packet_rate_hz: float | None = Field(default=None, ge=0)
    baseline_calibrated: bool = False
    source_mode: SourceMode


class RoomGeometry(StrictModel):
    """Operator-supplied 3D layout of TX, RX, and (optionally) the subject.

    Coordinates are in metres, in a local right-handed frame where:
      - x grows along the room's longer wall,
      - y grows up from the floor,
      - z grows along the shorter wall.

    None of these values are *sensed* — they exist solely to drive the 3D
    visualisation. Every position field defaults to ``None`` so consumers
    can tell "operator hasn't entered this yet" apart from "operator
    entered (0, 0, 0)". The 3D view refuses to render until every required
    field is populated; partial geometries surface an explicit setup
    prompt instead of a placeholder room.
    """

    schema_version: Literal["room_geometry.v1"] = "room_geometry.v1"
    room_extent_m: tuple[float, float, float] | None = None
    tx_position_m: tuple[float, float, float] | None = None
    rx_position_m: tuple[float, float, float] | None = None
    tx_orientation_deg: float = 0.0
    rx_orientation_deg: float = 0.0
    subject_position_m: tuple[float, float, float] | None = None
    subject_radius_m: float = Field(default=0.35, gt=0)
    notes: str | None = None
    updated_ns: int = 0

    @property
    def is_complete(self) -> bool:
        """True once room + TX + RX have been entered. Subject is optional."""
        return (
            self.room_extent_m is not None
            and self.tx_position_m is not None
            and self.rx_position_m is not None
        )


class ExperimentEvent(StrictModel):
    schema_version: Literal["experiment_event.v1"] = "experiment_event.v1"
    session_id: str
    event_id: str
    event_type: Literal[
        "session_started",
        "session_stopped",
        "label_added",
        "empty_room",
        "person_entered",
        "person_exited",
        "cross_los",
        "sit_still",
        "wave_hand",
        "breathing_trial",
        "distance_changed",
        "orientation_changed",
    ]
    ts_host_ns: int = Field(ge=0)
    label: str | None = None
    notes: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    source_mode: SourceMode
