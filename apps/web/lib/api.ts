import type { CalibrationStatus, LiveMessage, SessionRecord, SourceMode } from "./types";
import { devlog, makeRateCounter, startTimer } from "./devlog";

export const apiBase = process.env.NEXT_PUBLIC_AETHER_API ?? "http://127.0.0.1:8000";
export const wsUrl = process.env.NEXT_PUBLIC_AETHER_WS ?? "ws://127.0.0.1:8000/ws/live";

/*
 * Single fetch wrapper used by every API helper below. Responsibilities:
 *
 *   - tag every request with method + url so [rv:api] in the console is grep-able
 *   - measure server time (ms) so slow endpoints stand out
 *   - for non-2xx, log status + the response body so you do not have to open
 *     the Network tab to see why a call failed
 *   - convert non-2xx into thrown Error with a helpful message; the caller can
 *     still react via try/catch and surface it in the UI
 *
 * Why not generic fetch interceptors? Next.js does not give us one in the
 * client; this wrapper is the equivalent. Every code path that talks to the
 * API must go through it so the log stream stays consistent.
 */
async function rvFetch(url: string, init?: RequestInit, opName: string = "request"): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const stop = startTimer("api", `${method} ${opName} ${url}`, init?.body ? { hasBody: true } : undefined);
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      // Read body once, log it, then re-wrap so callers can throw with detail.
      let body = "";
      try { body = await response.text(); } catch { /* swallow */ }
      stop("error", { status: response.status, statusText: response.statusText, body });
      // Hand back a synthetic Response-like that already has the body consumed.
      // Caller paths below check response.ok, so we throw here for clarity.
      throw new Error(`${method} ${url} -> ${response.status} ${response.statusText}: ${body || "<empty body>"}`);
    }
    stop("info", { status: response.status });
    return response;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${method} `)) {
      // already logged + tagged above
      throw err;
    }
    devlog.error("api", `${method} ${opName} ${url} threw`, { error: err });
    throw err;
  }
}

export async function getHealth() {
  const response = await rvFetch(`${apiBase}/health`, { cache: "no-store" }, "health");
  return response.json() as Promise<{ status: string; source_mode: SourceMode; service: string }>;
}

export async function getDevices() {
  const response = await rvFetch(`${apiBase}/devices`, { cache: "no-store" }, "devices");
  return response.json() as Promise<Record<string, unknown>>;
}

export async function getSessions() {
  const response = await rvFetch(`${apiBase}/sessions`, { cache: "no-store" }, "sessions:list");
  return response.json() as Promise<SessionRecord[]>;
}

export async function createSession(payload: { protocol: string; notes?: string | null }) {
  const response = await rvFetch(
    `${apiBase}/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    },
    "sessions:create"
  );
  return response.json() as Promise<SessionRecord>;
}

export async function startSession(sessionId: string) {
  const response = await rvFetch(
    `${apiBase}/sessions/${sessionId}/start`,
    { method: "POST" },
    `sessions:start[${sessionId}]`
  );
  return response.json() as Promise<SessionRecord>;
}

export async function stopSession(sessionId: string) {
  const response = await rvFetch(
    `${apiBase}/sessions/${sessionId}/stop`,
    { method: "POST" },
    `sessions:stop[${sessionId}]`
  );
  return response.json() as Promise<SessionRecord>;
}

export async function addSessionEvent(sessionId: string, eventType: string) {
  const response = await rvFetch(
    `${apiBase}/sessions/${sessionId}/events`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_type: eventType })
    },
    `sessions:event[${sessionId}/${eventType}]`
  );
  return response.json();
}

export async function getSessionSummary(sessionId: string) {
  const response = await rvFetch(
    `${apiBase}/sessions/${sessionId}/summary`,
    { cache: "no-store" },
    `sessions:summary[${sessionId}]`
  );
  return response.json() as Promise<Record<string, unknown>>;
}

export async function getRoomSummary() {
  const response = await rvFetch(`${apiBase}/room/summary`, { cache: "no-store" }, "room:summary");
  return response.json();
}

export async function getCalibrationStatus(): Promise<CalibrationStatus> {
  const response = await rvFetch(`${apiBase}/calibration/baseline`, { cache: "no-store" }, "calibration:status");
  return response.json();
}

export async function startCalibration(durationSeconds = 10): Promise<CalibrationStatus> {
  const response = await rvFetch(
    `${apiBase}/calibration/baseline`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration_seconds: durationSeconds })
    },
    "calibration:start"
  );
  return response.json();
}

export async function resetCalibration(): Promise<CalibrationStatus> {
  const response = await rvFetch(`${apiBase}/calibration/baseline`, { method: "DELETE" }, "calibration:reset");
  return response.json();
}

export async function cancelCalibration(): Promise<CalibrationStatus> {
  const response = await rvFetch(`${apiBase}/calibration/baseline/cancel`, { method: "POST" }, "calibration:cancel");
  return response.json();
}

/*
 * connectLive owns the /ws/live WebSocket. It auto-reconnects on close with a
 * 2.5s backoff and reports state transitions to the caller via onStatus.
 *
 * Logging rules:
 *   - one info line per state change (connecting / connected / closed / error)
 *   - one warn line when reconnect kicks in, with attempt number + delay
 *   - debug rate counter for incoming messages (5 s window) instead of one
 *     line per frame, otherwise the console is unusable at 20 Hz
 *   - one warn line for malformed messages (JSON parse failure) with the raw
 *     payload truncated, so silent corruption does not just disappear
 */
export function connectLive(onMessage: (message: LiveMessage) => void, onStatus: (status: string) => void) {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const tickRecv = makeRateCounter("ws", "frames received");

  const open = () => {
    if (stopped) return;
    attempt += 1;
    onStatus("connecting");
    devlog.info("ws", `attempt ${attempt}: opening ${wsUrl}`);
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      onStatus("connected");
      devlog.info("ws", `open (attempt ${attempt})`, { url: wsUrl });
      attempt = 0;
    };
    socket.onclose = (event) => {
      if (stopped) return;
      onStatus("offline");
      devlog.warn("ws", "close; will reconnect in 2500 ms", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      });
      retry = globalThis.setTimeout(open, 2500);
    };
    socket.onerror = (event) => {
      onStatus("error");
      devlog.error("ws", "error event", { event });
      socket?.close();
    };
    socket.onmessage = (event) => {
      tickRecv();
      try {
        onMessage(JSON.parse(event.data) as LiveMessage);
      } catch (err) {
        const sample = typeof event.data === "string" ? event.data.slice(0, 200) : "<binary>";
        devlog.warn("ws", "malformed message; could not JSON.parse", { error: err, sample });
        onStatus("error");
      }
    };
  };

  open();

  return () => {
    stopped = true;
    devlog.info("ws", "client requested disconnect");
    if (retry) {
      globalThis.clearTimeout(retry);
    }
    socket?.close();
  };
}
