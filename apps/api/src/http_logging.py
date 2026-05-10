"""HTTP request/response logging middleware.

Logs one INFO line per request with method, path, status, duration. Logs the
request body for non-GET requests at DEBUG level (so it is OFF by default).
Logs a generated short request id so the same request can be tied to log lines
emitted later inside the route handler.

Why a custom middleware instead of uvicorn access logs?
  - we get the duration measured from the framework's POV (closer to wall
    time the user waits than uvicorn's pre-route timer)
  - we attach the request id to ``request.state`` so route code can include
    it in their own log lines (use ``request.state.req_id``)
  - we can format consistently with everything else in this codebase

The middleware is intentionally permissive about exceptions: if the handler
raises, we log it then re-raise so FastAPI's exception handlers still run.
"""

from __future__ import annotations

import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        req_id = uuid.uuid4().hex[:8]
        request.state.req_id = req_id
        client = request.client.host if request.client else "?"
        logger.info(
            "[http] >> %s %s %s from=%s",
            req_id,
            request.method,
            request.url.path,
            client,
        )
        if logger.isEnabledFor(logging.DEBUG) and request.method not in {"GET", "HEAD"}:
            # Reading the body here consumes it; we have to put it back so the
            # downstream route can read it again. Starlette caches when we
            # access request._body, which is the documented escape hatch.
            try:
                body_bytes = await request.body()
                if body_bytes:
                    snippet = body_bytes[:512].decode("utf-8", errors="replace")
                    logger.debug("[http] %s body[:512]=%s", req_id, snippet)
            except Exception:  # noqa: BLE001
                logger.debug("[http] %s body read failed", req_id, exc_info=True)

        started = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.exception(
                "[http] !! %s %s %s raised (%.1f ms)",
                req_id,
                request.method,
                request.url.path,
                elapsed_ms,
            )
            raise

        elapsed_ms = (time.perf_counter() - started) * 1000
        # WARN slow requests so they stand out without needing log filters.
        log = logger.warning if elapsed_ms > 750 else logger.info
        log(
            "[http] << %s %s %s -> %s (%.1f ms)",
            req_id,
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response
