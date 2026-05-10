from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from aether_protocol import SourceMode

# Resolve the repo root once. The current file is at
# apps/api/src/config.py, so going up four parents lands us at the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_ENV_LOADED = False


def _load_dotenv_once() -> None:
    """Load key=value pairs from `.env` at the repo root into os.environ.

    Hand-rolled (no python-dotenv dependency) because we only need a tiny
    subset: blank lines and `#` comments are skipped, surrounding quotes are
    stripped, and we never overwrite a value that's already set in the
    process environment. That last rule means `$env:AETHER_X = ...` in
    PowerShell still wins over `.env`, which is the right precedence for
    debugging.

    Idempotent: only reads the file once per Python process.
    """
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True
    env_path = _REPO_ROOT / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        # If we can't read .env we don't want to crash the API.
        # The downstream config will just see whatever the shell provided.
        pass


@dataclass(frozen=True)
class Settings:
    source_mode: SourceMode
    host: str
    port: int
    serial_port: str | None
    baud: int
    replay_path: Path | None
    data_dir: Path
    session_db: Path
    kb_root: Path


def get_settings() -> Settings:
    _load_dotenv_once()
    data_dir = Path(os.getenv("AETHER_DATA_DIR", "./data"))
    replay_path = Path(os.getenv("AETHER_REPLAY_PATH", "")) if os.getenv("AETHER_REPLAY_PATH") else None
    return Settings(
        source_mode=SourceMode.REPLAY if replay_path else SourceMode.LIVE,
        host=os.getenv("AETHER_API_HOST", "127.0.0.1"),
        port=int(os.getenv("AETHER_API_PORT", "8000")),
        serial_port=os.getenv("AETHER_SERIAL_PORT") or None,
        baud=int(os.getenv("AETHER_BAUD", "115200")),
        replay_path=replay_path,
        data_dir=data_dir,
        session_db=Path(os.getenv("AETHER_SESSION_DB", str(data_dir / "aether.sqlite"))),
        kb_root=Path(os.getenv("AETHER_KB_ROOT", "./docs")),
    )
