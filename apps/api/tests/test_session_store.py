from pathlib import Path

from apps.api.src.services.session_store import SessionStore
from aether_protocol import SourceMode


def test_create_session(tmp_path: Path):
    store = SessionStore(tmp_path / "rv.sqlite", tmp_path)
    session = store.create_session(source_mode=SourceMode.LIVE)
    assert session["source_mode"] == "LIVE"
    assert store.list_sessions()
