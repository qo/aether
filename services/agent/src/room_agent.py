from __future__ import annotations

from .room_tools_mcp import RoomTools


class RoomAgent:
    def __init__(self, tools: RoomTools) -> None:
        self.tools = tools

    def answer(self, question: str) -> dict[str, object]:
        normalized = question.lower()
        tools_used: list[str] = []

        if "what changed" in normalized or "last 30" in normalized:
            tools_used.append("get_recent_derived_windows")
            windows = self.tools.get_recent_derived_windows(30)
            latest = (windows.get("windows") or [None])[-1]
            if not latest:
                return self._low_confidence("No recent derived windows are available.", tools_used)
            return {
                "answer": "Measured change is limited to the latest derived RF window; identity, emotion, medical meaning, and heartbeat are unknown.",
                "facts": latest,
                "confidence": latest.get("quality_score", 0.0) if isinstance(latest, dict) else 0.0,
                "tools_used": tools_used,
            }

        if "still not know" in normalized or "unknown" in normalized:
            tools_used.append("list_open_research_questions")
            questions = self.tools.list_open_research_questions()
            return {
                "answer": "Open questions remain around geometry, packet cadence, respiration feasibility, day-to-day multipath, and validation sensors.",
                "facts": questions,
                "confidence": 0.8,
                "tools_used": tools_used,
            }

        tools_used.append("get_live_room_summary")
        summary = self.tools.get_live_room_summary()
        return {
            "answer": "The current room state can only be reported from stored or live derived measurements; does not infer identity, emotion, medical meaning, or heartbeat.",
            "facts": summary,
            "confidence": _summary_confidence(summary),
            "tools_used": tools_used,
        }

    def _low_confidence(self, answer: str, tools_used: list[str]) -> dict[str, object]:
        return {
            "answer": answer,
            "facts": {},
            "confidence": 0.0,
            "tools_used": tools_used,
        }


def _summary_confidence(summary: dict[str, object]) -> float:
    latest = summary.get("latest_window")
    if isinstance(latest, dict) and "quality_score" in latest:
        return float(latest["quality_score"])
    if "confidence" in summary:
        return float(summary["confidence"])
    return 0.0
