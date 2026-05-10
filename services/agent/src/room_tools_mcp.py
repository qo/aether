from __future__ import annotations

from pathlib import Path

from apps.api.src.services.session_store import SessionStore
from services.kb.src.search import search_knowledge_base as kb_search


class RoomTools:
    def __init__(self, *, store: SessionStore, kb_root: Path) -> None:
        self.store = store
        self.kb_root = kb_root

    def get_live_room_summary(self) -> dict[str, object]:
        sessions = self.store.list_sessions()
        if not sessions:
            return {
                "status": "no_sessions",
                "confidence": 0.0,
                "unknowns": ["no sessions have been created"],
            }
        latest = sessions[0]
        return self.store.summarize_session(str(latest["session_id"]))

    def get_recent_derived_windows(self, seconds: int) -> dict[str, object]:
        sessions = self.store.list_sessions()
        if not sessions:
            return {"windows": [], "seconds": seconds}
        summary = self.store.summarize_session(str(sessions[0]["session_id"]))
        latest = summary.get("latest_window")
        return {"seconds": seconds, "windows": [latest] if latest else []}

    def get_session_summary(self, session_id: str) -> dict[str, object]:
        return self.store.summarize_session(session_id)

    def search_knowledge_base(self, query: str) -> list[dict[str, object]]:
        return [
            {
                "path": str(result.path),
                "title": result.title,
                "score": result.score,
                "excerpt": result.excerpt,
                "verification_labels": result.verification_labels,
            }
            for result in kb_search(self.kb_root, query)
        ]

    def list_open_research_questions(self) -> list[dict[str, object]]:
        return self.search_knowledge_base("open research questions unknown needs verification")

    def compare_sessions(self, session_a: str, session_b: str) -> dict[str, object]:
        a = self.store.summarize_session(session_a)
        b = self.store.summarize_session(session_b)
        a_window = a.get("latest_window") or {}
        b_window = b.get("latest_window") or {}
        return {
            "session_a": session_a,
            "session_b": session_b,
            "comparison": {
                "raw_frame_delta": int(b["raw_frame_count"]) - int(a["raw_frame_count"]),
                "motion_score_delta": _delta(a_window, b_window, "motion_score"),
                "occupancy_score_delta": _delta(a_window, b_window, "occupancy_score"),
                "quality_score_delta": _delta(a_window, b_window, "quality_score"),
            },
            "cannot_conclude": ["identity", "emotion", "medical meaning", "heartbeat"],
        }


def _delta(left: object, right: object, key: str) -> float | None:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return None
    if key not in left or key not in right:
        return None
    return float(right[key]) - float(left[key])
