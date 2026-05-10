from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import TextIO
from uuid import uuid4

from aether_protocol import (
    DerivedWindow,
    ExperimentEvent,
    RawCsiFrame,
    RoomGeometry,
    SourceMode,
)


class SessionStore:
    """SQLite + JSONL store with persistent handles and batched flushing.

    Hot-path notes:
    - SQLite uses a single persistent connection in WAL mode so writes don't
      pay journal-create cost per call.
    - JSONL files are kept open across appends (one handle per session per
      stream) and flushed every ``flush_every_n`` lines. Closing happens on
      ``stop_session`` or process shutdown.
    - Raw-frame persistence can be disabled via ``AETHER_PERSIST_RAW=0``
      for demo runs that don't need a stored stream — at 20 Hz with a 384-
      byte CSI payload the JSONL grows ~30 KB/s, which adds up over a
      multi-minute session.
    """

    def __init__(
        self,
        db_path: Path,
        data_dir: Path,
        *,
        persist_raw: bool | None = None,
        flush_every_n: int = 50,
    ) -> None:
        self.db_path = db_path
        self.data_dir = data_dir
        self.recordings_dir = data_dir / "recordings"
        self.exports_dir = data_dir / "exports"
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Env override: AETHER_PERSIST_RAW=0 disables raw persistence.
        if persist_raw is None:
            persist_raw = os.getenv("AETHER_PERSIST_RAW", "1") not in ("0", "false", "False", "")
        self.persist_raw = persist_raw
        self.flush_every_n = max(1, int(flush_every_n))
        self._raw_handles: dict[str, TextIO] = {}
        self._raw_counters: dict[str, int] = {}
        self._derived_handles: dict[str, TextIO] = {}
        self._derived_counters: dict[str, int] = {}
        self._db: sqlite3.Connection | None = None
        self._init_db()

    # ---------- SQLite plumbing ----------

    def _connect(self) -> sqlite3.Connection:
        """Return a persistent SQLite connection in WAL mode.

        Single connection across the asyncio loop is safe (runtime is
        single-threaded). Pragmas:
          - WAL: writers don't block readers; checkpointing happens
            opportunistically and is durable.
          - synchronous=NORMAL: ~10x faster for bursty inserts; loses at
            most the most recent transaction on power loss, which is
            acceptable for V0 sensing data.
          - temp_store=MEMORY: keeps temporary tables (sort, group) in RAM.
        """
        if self._db is not None:
            return self._db
        # check_same_thread=False: we drive this from asyncio's event loop
        # which runs on a single thread, but threadpool-bridged code paths
        # (like to_thread reads in the serial reader) can momentarily call
        # in. The single-writer-at-a-time invariant still holds because
        # we never schedule overlapping writes.
        connection = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("PRAGMA cache_size=-8000")  # ~8 MB page cache
        self._db = connection
        return connection

    def _init_db(self) -> None:
        db = self._connect()
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                source_mode TEXT NOT NULL,
                protocol TEXT NOT NULL,
                notes TEXT,
                consent TEXT NOT NULL,
                started_ns INTEGER,
                stopped_ns INTEGER,
                created_ns INTEGER NOT NULL
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                ts_host_ns INTEGER NOT NULL
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS room_geometry (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_ns INTEGER NOT NULL
            )
            """
        )
        # Persistent calibration. One row per (room install) keyed by
        # the literal "current" — same convention as room_geometry.
        # Stores the BaselineSnapshot as JSON so future schema changes
        # can be migrated by the calibrator without altering the table.
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS calibration_baseline (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                stage TEXT NOT NULL,
                updated_ns INTEGER NOT NULL
            )
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts_host_ns)")

    # ---------- Sessions ----------

    def create_session(
        self,
        *,
        source_mode: SourceMode,
        protocol: str = "empty_room_baseline",
        notes: str | None = None,
        consent: str = "local_experimenter_recorded",
    ) -> dict[str, object]:
        session_id = str(uuid4())
        created_ns = time.time_ns()
        db = self._connect()
        db.execute(
            """
            INSERT INTO sessions (
                session_id, source_mode, protocol, notes, consent, started_ns, stopped_ns, created_ns
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
            """,
            (session_id, source_mode.value, protocol, notes, consent, created_ns),
        )
        return self.get_session(session_id)

    def start_session(self, session_id: str) -> dict[str, object]:
        db = self._connect()
        db.execute(
            "UPDATE sessions SET started_ns = COALESCE(started_ns, ?) WHERE session_id = ?",
            (time.time_ns(), session_id),
        )
        return self.get_session(session_id)

    def stop_session(self, session_id: str) -> dict[str, object]:
        db = self._connect()
        db.execute(
            "UPDATE sessions SET stopped_ns = ? WHERE session_id = ?",
            (time.time_ns(), session_id),
        )
        # Close per-session JSONL handles so buffers flush to disk.
        self._close_handles(session_id)
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict[str, object]:
        db = self._connect()
        row = db.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise KeyError(session_id)
        return dict(row)

    def list_sessions(self) -> list[dict[str, object]]:
        db = self._connect()
        rows = db.execute("SELECT * FROM sessions ORDER BY created_ns DESC").fetchall()
        return [dict(row) for row in rows]

    def append_event(self, event: ExperimentEvent) -> None:
        db = self._connect()
        db.execute(
            "INSERT OR REPLACE INTO events (event_id, session_id, payload, ts_host_ns) VALUES (?, ?, ?, ?)",
            (event.event_id, event.session_id, event.model_dump_json(), event.ts_host_ns),
        )

    # ---------- Room geometry ----------

    def get_room_geometry(self) -> RoomGeometry:
        db = self._connect()
        row = db.execute("SELECT payload FROM room_geometry WHERE id = 'current'").fetchone()
        if row is None:
            return RoomGeometry()
        try:
            return RoomGeometry.model_validate_json(row["payload"])
        except Exception:  # noqa: BLE001
            return RoomGeometry()

    def set_room_geometry(self, geometry: RoomGeometry) -> RoomGeometry:
        payload = geometry.model_copy(update={"updated_ns": time.time_ns()})
        db = self._connect()
        db.execute(
            "INSERT OR REPLACE INTO room_geometry (id, payload, updated_ns) VALUES ('current', ?, ?)",
            (payload.model_dump_json(), payload.updated_ns),
        )
        return payload

    # ---------- Calibration persistence (item 8.2) ----------

    def get_calibration(self) -> tuple[str, dict[str, object]] | None:
        """Return (stage, payload) or None if no baseline has been stored."""
        db = self._connect()
        row = db.execute(
            "SELECT payload, stage FROM calibration_baseline WHERE id = 'current'"
        ).fetchone()
        if row is None:
            return None
        try:
            return (str(row["stage"]), json.loads(row["payload"]))
        except Exception:  # noqa: BLE001
            return None

    def set_calibration(self, *, stage: str, payload: dict[str, object]) -> None:
        db = self._connect()
        db.execute(
            "INSERT OR REPLACE INTO calibration_baseline (id, payload, stage, updated_ns) "
            "VALUES ('current', ?, ?, ?)",
            (json.dumps(payload, default=str), stage, time.time_ns()),
        )

    def clear_calibration(self) -> None:
        db = self._connect()
        db.execute("DELETE FROM calibration_baseline WHERE id = 'current'")

    # ---------- Hot path: append raw / derived ----------

    def _raw_path(self, session_id: str) -> Path:
        return self.recordings_dir / f"{session_id}.jsonl"

    def _derived_path(self, session_id: str) -> Path:
        return self.recordings_dir / f"{session_id}.derived.jsonl"

    def _close_handles(self, session_id: str) -> None:
        for store in (self._raw_handles, self._derived_handles):
            handle = store.pop(session_id, None)
            if handle is not None:
                try:
                    handle.flush()
                    handle.close()
                except OSError:
                    pass
        self._raw_counters.pop(session_id, None)
        self._derived_counters.pop(session_id, None)

    def append_raw_frame(self, frame: RawCsiFrame) -> Path | None:
        if not self.persist_raw:
            return None
        path = self._raw_path(frame.session_id)
        handle = self._raw_handles.get(frame.session_id)
        if handle is None:
            handle = path.open("a", encoding="utf-8", buffering=8192)
            self._raw_handles[frame.session_id] = handle
            self._raw_counters[frame.session_id] = 0
        handle.write(frame.model_dump_json())
        handle.write("\n")
        n = self._raw_counters[frame.session_id] + 1
        if n >= self.flush_every_n:
            handle.flush()
            n = 0
        self._raw_counters[frame.session_id] = n
        return path

    def append_derived_window(self, window: DerivedWindow) -> Path:
        path = self._derived_path(window.session_id)
        handle = self._derived_handles.get(window.session_id)
        if handle is None:
            handle = path.open("a", encoding="utf-8", buffering=8192)
            self._derived_handles[window.session_id] = handle
            self._derived_counters[window.session_id] = 0
        handle.write(window.model_dump_json())
        handle.write("\n")
        # Derived windows arrive ~5x slower than raw frames (one per ~10
        # raw frames in V0 DSP), so a smaller flush threshold still keeps
        # the on-disk view fresh for the Data Explorer tab.
        n = self._derived_counters[window.session_id] + 1
        if n >= max(1, self.flush_every_n // 5):
            handle.flush()
            n = 0
        self._derived_counters[window.session_id] = n
        return path

    # ---------- Read paths (unchanged from prior version) ----------

    def read_raw_frames(
        self,
        session_id: str,
        *,
        from_ns: int | None = None,
        to_ns: int | None = None,
        limit: int = 200,
        latest: bool = False,
    ) -> list[dict[str, object]]:
        # If this session is currently writing, flush before reading so
        # the caller sees the most recent frames.
        handle = self._raw_handles.get(session_id)
        if handle is not None:
            try:
                handle.flush()
            except OSError:
                pass
        path = self._raw_path(session_id)
        if not path.exists():
            return []
        out: list[dict[str, object]] = []
        if latest:
            with path.open("r", encoding="utf-8") as handle_r:
                tail: list[str] = []
                for line in handle_r:
                    if not line.strip():
                        continue
                    tail.append(line)
                    if len(tail) > limit:
                        tail.pop(0)
            for line in tail:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            return out
        with path.open("r", encoding="utf-8") as handle_r:
            for line in handle_r:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = int(record.get("ts_host_ns", 0))
                if from_ns is not None and ts < from_ns:
                    continue
                if to_ns is not None and ts > to_ns:
                    continue
                out.append(record)
                if len(out) >= limit:
                    break
        return out

    def summarize_session(self, session_id: str) -> dict[str, object]:
        # Flush any in-flight writes so counts are accurate.
        for store in (self._raw_handles, self._derived_handles):
            h = store.get(session_id)
            if h is not None:
                try:
                    h.flush()
                except OSError:
                    pass
        session = self.get_session(session_id)
        raw_path = self._raw_path(session_id)
        parquet_path = self.recordings_dir / f"{session_id}.parquet"
        derived_path = self._derived_path(session_id)
        events = self.list_events(session_id)
        raw_count = sum(1 for _ in raw_path.open("r", encoding="utf-8")) if raw_path.exists() else 0
        derived: list[dict[str, object]] = []
        if derived_path.exists():
            with derived_path.open("r", encoding="utf-8") as handle:
                derived = [json.loads(line) for line in handle if line.strip()]
        latest = derived[-1] if derived else None
        return {
            "session": session,
            "raw_frame_count": raw_count,
            "raw_jsonl_path": str(raw_path),
            "raw_parquet_path": str(parquet_path) if parquet_path.exists() else None,
            "derived_window_count": len(derived),
            "event_count": len(events),
            "latest_window": latest,
            "conclusions": {
                "measured": "packet/RSSI/quality/motion/occupancy/anomaly only",
                "cannot_conclude": ["identity", "emotion", "medical meaning", "heartbeat"],
            },
        }

    def list_events(self, session_id: str) -> list[dict[str, object]]:
        db = self._connect()
        rows = db.execute(
            "SELECT payload FROM events WHERE session_id = ? ORDER BY ts_host_ns ASC",
            (session_id,),
        ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def export_session_report(self, session_id: str) -> Path:
        summary = self.summarize_session(session_id)
        parquet_path = self.export_raw_parquet(session_id)
        path = self.exports_dir / f"{session_id}.report.md"
        path.write_text(
            "\n".join(
                [
                    f"# Aether Session Report: {session_id}",
                    "",
                    "Purpose: summarize one recorded or replayed RF sensing session.",
                    "",
                    "## What Is Confirmed / What Is Unknown",
                    "",
                    "- [Confirmed in code] This report is generated from stored session metadata and frames.",
                    "- [Unknown / needs verification] Hardware conclusions require live source mode and experiment notes.",
                    "",
                    "## Summary",
                    "",
                    f"- Raw frames: {summary['raw_frame_count']}",
                    f"- Parquet export: {parquet_path if parquet_path else 'not generated'}",
                    f"- Derived windows: {summary['derived_window_count']}",
                    f"- Events: {summary['event_count']}",
                    "",
                    "## Conclusions",
                    "",
                    "- Measured: packet rate, RSSI, quality, motion, occupancy, anomaly.",
                    "- Cannot conclude: identity, emotion, medical meaning, heartbeat.",
                ]
            ),
            encoding="utf-8",
        )
        return path

    def export_raw_parquet(self, session_id: str) -> Path | None:
        raw_path = self._raw_path(session_id)
        if not raw_path.exists():
            return None
        records: list[dict[str, object]] = []
        with raw_path.open("r", encoding="utf-8") as handle:
            records = [json.loads(line) for line in handle if line.strip()]
        if not records:
            return None
        try:
            import pyarrow as pa  # type: ignore
            import pyarrow.parquet as pq  # type: ignore
        except ImportError:
            return None
        parquet_path = self.recordings_dir / f"{session_id}.parquet"
        pq.write_table(pa.Table.from_pylist(records), parquet_path)
        return parquet_path

    # ---------- Shutdown ----------

    def close(self) -> None:
        """Flush and close all open handles. Safe to call multiple times."""
        for store in (list(self._raw_handles.items()), list(self._derived_handles.items())):
            for sid, _h in store:
                self._close_handles(sid)
        if self._db is not None:
            try:
                self._db.commit()
                self._db.close()
            except sqlite3.Error:
                pass
            self._db = None
