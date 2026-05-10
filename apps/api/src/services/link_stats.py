"""Live host-side link statistics — packet rate, inter-arrival jitter, drops.

Single source of truth for "how is the radio link doing right now" across
the runtime. The collector calls ``record_frame`` on every parsed CSI frame
and ``record_heartbeat`` on every firmware heartbeat envelope. The DSP
runtime reads ``snapshot()`` to get an EMA-smoothed observed packet rate
that it then uses as the *expected* rate for quality scoring. The
``/diagnostics/link`` REST route serialises the same snapshot for the UI.

This is the Phase A piece of the calibration plan — without it, every
quality / motion / occupancy threshold downstream is calibrated against a
hardcoded 20 Hz expectation that the hardware is not actually delivering.
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock

# Sliding window of inter-arrival deltas (in nanoseconds). Sized for ~30 s
# at 20 Hz so percentile estimates are stable but cheap to recompute.
_DELTA_WINDOW = 600

# EMA half-life for packet rate smoothing. Half-life of 5 s means a step
# change is ~50% reflected after 5 s, ~94% after 20 s.
_RATE_EMA_HALF_LIFE_S = 5.0


@dataclass
class LinkSnapshot:
    observed_packet_rate_hz: float
    expected_packet_rate_hz: float
    inter_arrival_p50_ms: float | None
    inter_arrival_p90_ms: float | None
    inter_arrival_p99_ms: float | None
    inter_arrival_max_ms: float | None
    inter_arrival_jitter_ms: float | None
    rssi_p50_dbm: float | None
    rssi_std_dbm: float | None
    noise_floor_p50_dbm: float | None
    first_word_invalid_ratio: float
    frames_seen: int
    firmware_packets_seen: int | None
    firmware_dropped: int | None
    firmware_queue_depth: int | None
    rate_stable: bool
    last_frame_age_s: float | None
    notes: list[str] = field(default_factory=list)


class LinkStats:
    """Thread-safe rolling link diagnostics. Cheap to update; cheap to read."""

    def __init__(self, *, expected_default_hz: float = 20.0) -> None:
        self._lock = Lock()
        self._deltas_ns: deque[int] = deque(maxlen=_DELTA_WINDOW)
        self._rssi: deque[int] = deque(maxlen=_DELTA_WINDOW)
        self._noise: deque[int] = deque(maxlen=_DELTA_WINDOW)
        self._fwi_count: int = 0
        self._frames_total: int = 0
        self._last_ts_host_ns: int | None = None
        self._last_seen_monotonic: float | None = None
        self._ema_rate_hz: float | None = None
        self._ema_last_t: float | None = None
        self._fw_packets_seen: int | None = None
        self._fw_dropped: int | None = None
        self._fw_queue_depth: int | None = None
        self._expected_default_hz = float(expected_default_hz)
        self._rate_stable_at: float | None = None

    def reset(self) -> None:
        with self._lock:
            self._deltas_ns.clear()
            self._rssi.clear()
            self._noise.clear()
            self._fwi_count = 0
            self._frames_total = 0
            self._last_ts_host_ns = None
            self._last_seen_monotonic = None
            self._ema_rate_hz = None
            self._ema_last_t = None
            self._fw_packets_seen = None
            self._fw_dropped = None
            self._fw_queue_depth = None
            self._rate_stable_at = None

    def record_frame(
        self,
        *,
        ts_host_ns: int,
        rssi_dbm: int,
        noise_floor_dbm: int,
        first_word_invalid: bool,
    ) -> None:
        now = time.monotonic()
        with self._lock:
            self._frames_total += 1
            self._rssi.append(int(rssi_dbm))
            self._noise.append(int(noise_floor_dbm))
            if first_word_invalid:
                self._fwi_count += 1
            if self._last_ts_host_ns is not None:
                delta = int(ts_host_ns) - int(self._last_ts_host_ns)
                if 0 < delta < 5_000_000_000:  # ignore clock resets
                    self._deltas_ns.append(delta)
                    instantaneous_hz = 1_000_000_000 / max(delta, 1)
                    self._update_rate_ema(instantaneous_hz, now)
            self._last_ts_host_ns = int(ts_host_ns)
            self._last_seen_monotonic = now

    def record_heartbeat(
        self,
        *,
        packets_seen: int | None = None,
        dropped: int | None = None,
        queue_depth: int | None = None,
    ) -> None:
        with self._lock:
            if packets_seen is not None:
                self._fw_packets_seen = int(packets_seen)
            if dropped is not None:
                self._fw_dropped = int(dropped)
            if queue_depth is not None:
                self._fw_queue_depth = int(queue_depth)

    def observed_rate_hz(self) -> float:
        with self._lock:
            return float(self._ema_rate_hz or 0.0)

    def is_rate_stable(self) -> bool:
        """True once we have a long-enough EMA window to trust the rate.

        Used by the runtime to decide when to swap the hardcoded
        ``expected_packet_rate_hz`` for the measured value.
        """
        with self._lock:
            return self._rate_stable_at is not None

    def snapshot(self) -> LinkSnapshot:
        with self._lock:
            deltas_ms = [d / 1_000_000 for d in self._deltas_ns]
            p50 = _percentile(deltas_ms, 50)
            p90 = _percentile(deltas_ms, 90)
            p99 = _percentile(deltas_ms, 99)
            mx = max(deltas_ms) if deltas_ms else None
            jitter = _stddev(deltas_ms) if len(deltas_ms) >= 2 else None
            rssi_list = list(self._rssi)
            noise_list = list(self._noise)
            rssi_med = _percentile(rssi_list, 50) if rssi_list else None
            rssi_std = _stddev(rssi_list) if len(rssi_list) >= 2 else None
            noise_med = _percentile(noise_list, 50) if noise_list else None
            fwi_ratio = (
                self._fwi_count / self._frames_total if self._frames_total else 0.0
            )
            last_age = (
                None
                if self._last_seen_monotonic is None
                else max(0.0, time.monotonic() - self._last_seen_monotonic)
            )
            notes: list[str] = []
            if self._fw_dropped:
                notes.append(
                    f"firmware reports {self._fw_dropped} dropped frames "
                    "(CSI queue overflowed)"
                )
            if self._fw_queue_depth and self._fw_queue_depth > 4:
                notes.append(
                    f"firmware queue depth {self._fw_queue_depth} — host is "
                    "not draining fast enough"
                )
            if last_age is not None and last_age > 2.0:
                notes.append(
                    f"no frames for {last_age:.1f}s — link may be stalled"
                )
            return LinkSnapshot(
                observed_packet_rate_hz=float(self._ema_rate_hz or 0.0),
                expected_packet_rate_hz=self._expected_default_hz,
                inter_arrival_p50_ms=p50,
                inter_arrival_p90_ms=p90,
                inter_arrival_p99_ms=p99,
                inter_arrival_max_ms=mx,
                inter_arrival_jitter_ms=jitter,
                rssi_p50_dbm=rssi_med,
                rssi_std_dbm=rssi_std,
                noise_floor_p50_dbm=noise_med,
                first_word_invalid_ratio=float(fwi_ratio),
                frames_seen=self._frames_total,
                firmware_packets_seen=self._fw_packets_seen,
                firmware_dropped=self._fw_dropped,
                firmware_queue_depth=self._fw_queue_depth,
                rate_stable=self._rate_stable_at is not None,
                last_frame_age_s=last_age,
                notes=notes,
            )

    # ---- internal helpers (caller holds lock) ----

    def _update_rate_ema(self, instantaneous_hz: float, now: float) -> None:
        if instantaneous_hz <= 0 or instantaneous_hz > 200:
            return
        if self._ema_rate_hz is None or self._ema_last_t is None:
            self._ema_rate_hz = instantaneous_hz
            self._ema_last_t = now
            return
        dt = max(now - self._ema_last_t, 1e-3)
        # Convert half-life to per-step decay; clamp alpha to [0, 1].
        alpha = 1.0 - math.pow(0.5, dt / _RATE_EMA_HALF_LIFE_S)
        alpha = max(0.0, min(1.0, alpha))
        self._ema_rate_hz = (1.0 - alpha) * self._ema_rate_hz + alpha * instantaneous_hz
        self._ema_last_t = now
        # Mark the rate as stable once we've held an EMA over enough samples
        # with a non-degenerate value. Used by the runtime to swap the
        # expected_packet_rate_hz from the default to the observed value.
        if (
            self._rate_stable_at is None
            and len(self._deltas_ns) >= 30
            and self._ema_rate_hz > 0.5
        ):
            self._rate_stable_at = now


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    rank = (pct / 100.0) * (len(s) - 1)
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return float(s[lo])
    frac = rank - lo
    return float(s[lo] * (1.0 - frac) + s[hi] * frac)


def _stddev(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return math.sqrt(var)
