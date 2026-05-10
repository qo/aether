from __future__ import annotations

import logging

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import build_router
from .config import get_settings
from .health.routes import router as health_router
from .http_logging import RequestLoggingMiddleware
from .logging_setup import configure_logging
from .services.runtime import RuntimeState
from .services.session_store import SessionStore
from .ws.live import live_websocket

# Configure logging before anything else imports a module-level logger and
# captures a handler with a stale level.
configure_logging()

logger = logging.getLogger(__name__)

settings = get_settings()
logger.info(
    "[boot] settings source_mode=%s host=%s port=%s serial_port=%s baud=%s data_dir=%s replay_path=%s",
    settings.source_mode,
    settings.host,
    settings.port,
    settings.serial_port,
    settings.baud,
    settings.data_dir,
    settings.replay_path,
)
store = SessionStore(settings.session_db, settings.data_dir)
state = RuntimeState(store=store)
logger.info("[boot] RuntimeState ready, session_db=%s", settings.session_db)

app = FastAPI(title="Aether API", version="0.1.0")
app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health_router)
app.include_router(build_router(state))


@app.on_event("startup")
async def _startup() -> None:
    logger.info("[boot] FastAPI startup complete; routes=%d", len(app.router.routes))


@app.on_event("shutdown")
async def shutdown() -> None:
    logger.info("[boot] shutdown: stopping runtime tasks")
    await state.stop()
    logger.info("[boot] shutdown complete")


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket) -> None:
    await live_websocket(websocket, state)
