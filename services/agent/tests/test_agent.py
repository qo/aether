from pathlib import Path

from apps.api.src.services.session_store import SessionStore
from aether_protocol import SourceMode
from services.agent.src.room_agent import RoomAgent
from services.agent.src.room_tools_mcp import RoomTools


def test_agent_reports_unknown_without_sessions(tmp_path: Path):
    store = SessionStore(tmp_path / "rv.sqlite", tmp_path)
    agent = RoomAgent(RoomTools(store=store, kb_root=Path("docs")))
    answer = agent.answer("What is happening in the room right now?")
    assert answer["confidence"] == 0.0
    assert "tools_used" in answer
