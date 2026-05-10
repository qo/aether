from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from uuid import uuid4

from aether_protocol import DerivedWindow, ExperimentEvent, RawCsiFrame, SourceMode


class SessionStore:
    def __init__(self, db_path: Path, data_dir: Path) -> None:
        self.db_path = db_path
        self.data_dir = data_dir
        self.recordings_dir = data_dir / "recordings"
        self.exports_dir = data_dir / "exports"
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        with self._connect() as db:
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
        with self._connect() as db:
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
        with self._connect() as db:
            db.execute(
                "UPDATE sessions SET started_ns = COALESCE(started_ns, ?) WHERE session_id = ?",
                (time.time_ns(), session_id),
            )
        return self.get_session(session_id)

    def stop_session(self, session_id: str) -> dict[str, object]:
        with self._connect() as db:
            db.execute(
                "UPDATE sessions SET stopped_ns = ? WHERE session_id = ?",
                (time.time_ns(), session_id),
            )
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict[str, object]:
        with self._connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise KeyError(session_id)
        return dict(row)

    def list_sessions(self) -> list[dict[str, object]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY created_ns DESC").fetchall()
        return [dict(row) for row in rows]

    def append_event(self, event: ExperimentEvent) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO events (event_id, session_id, payload, ts_host_ns) VALUES (?, ?, ?, ?)",
                (
                    event.event_id,
                    event.session_id,
                    event.model_dump_json(),
                    event.ts_host_ns,
                ),
            )

    def append_raw_frame(self, frame: RawCsiFrame) -> Path:
        path = self.recordings_dir / f"{frame.session_id}.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(frame.model_dump_json() + "\n")
        return path

    def append_derived_window(self, window: DerivedWindow) -> Path:
        path = self.recordings_dir / f"{window.session_id}.derived.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(window.model_dump_json() + "\n")
        return path

    def summarize_session(self, session_id: str) -> dict[str, object]:
        session = self.get_session(session_id)
        raw_path = self.recordings_dir / f"{session_id}.jsonl"
        parquet_path = self.recordings_dir / f"{session_id}.parquet"
        derived_path = self.recordings_dir / f"{session_id}.derived.jsonl"
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
        with self._connect() as db:
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
        raw_path = self.recordings_dir / f"{session_id}.jsonl"
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
