r"""Centralised logging configuration for the Aether API.

One place to control log format, level, and which third-party loggers we want
to see or silence. Imported once from main.py at startup.

Conventions used in this codebase:

  - logger names follow the module name (``logging.getLogger(__name__)``)
  - tags are embedded in the message itself with bracketed prefixes so a
    ``grep '\[http]'`` works even without structured fields. Current tags:
        [boot]   - app lifecycle (startup, shutdown)
        [http]   - request middleware lines
        [ws]     - WebSocket lifecycle and per-connection events
        [route]  - explicit per-route logs from api/routes.py
        [runtime]- collector/DSP runtime (frame publish, calibration, etc.)
  - INFO is the default and should be safe to leave on in dev. DEBUG turns on
    per-frame chatter (publish_frame, ws send) and is OFF by default; flip it
    via the ``AETHER_LOG_LEVEL`` env var.

Format: ``HH:MM:SS.mmm LEVEL logger.name | message``. Compact enough to scan
in a terminal and still includes a millisecond clock so you can correlate
front-end and back-end events when the UI is misbehaving.
"""

from __future__ import annotations

import logging
import os
import sys

_CONFIGURED = False


def configure_logging() -> None:
    """Install handlers + format. Idempotent; safe to call more than once."""

    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True

    level_name = os.getenv("AETHER_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s.%(msecs)03d %(levelname)-5s %(name)s | %(message)s",
            datefmt="%H:%M:%S",
        )
    )

    root = logging.getLogger()
    # Reset existing handlers so uvicorn/pytest/etc. do not double-print.
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # uvicorn ships its own access logger; we route it through ours so the
    # format is consistent. Setting propagate=True + clearing handlers lets
    # the records reach our root handler without uvicorn's coloured prefix.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        target = logging.getLogger(name)
        target.handlers.clear()
        target.propagate = True
        target.setLevel(level)

    # The requests/urllib3 chatter is rarely useful while debugging our own
    # code. Silence it unless the operator explicitly bumps the level.
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    logging.getLogger(__name__).info(
        "[boot] logging configured level=%s (override with AETHER_LOG_LEVEL)",
        level_name,
    )
