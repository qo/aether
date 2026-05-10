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
