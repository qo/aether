import type {
  CalibrationStatus,
  LinkDiagnostics,
  LiveMessage,
  RawFrame,
  RoomGeometry,
  SessionRecord,
  SourceMode,
  SubcarrierDiagnostics,
} from "./types";
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
 *
 * Log throttling: when uvicorn is offline, every poller flips into a "threw"
 * loop. Logging each one buries everything else in the console. We dedupe per
 * opName: the first failure logs an error, the recovery logs an info, and any
 * repeated failures in between are silent. That keeps the offline → online
 * transitions visible without drowning out the real signal.
 */
const lastApiState = new Map<string, "ok" | "down">();

function noteSuccess(opName: string) {
  if (lastApiState.get(opName) === "down") {
    devlog.info("api", `${opName} recovered`);
  }
  lastApiState.set(opName, "ok");
}

function noteFailure(opName: string, kind: string, payload: Record<string, unknown>) {
  if (lastApiState.get(opName) !== "down") {
    devlog.error("api", `${opName} ${kind} (further failures silenced until recovery)`, payload);
  }
  lastApiState.set(opName, "down");
}

async function rvFetch(url: string, init?: RequestInit, opName: string = "request"): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const tag = `${method} ${opName}`;
  const stop = startTimer("api", `${tag} ${url}`, init?.body ? { hasBody: true } : undefined);
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* swallow */ }
      stop("debug", { status: response.status, statusText: response.statusText });
      noteFailure(opName, `non-2xx (${response.status})`, {
        status: response.status,
        statusText: response.statusText,
        body,
      });
      throw new Error(`${method} ${url} -> ${response.status} ${response.statusText}: ${body || "<empty body>"}`);
    }
    stop("debug", { status: response.status });
    noteSuccess(opName);
    return response;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${method} `)) {
      // Status error already accounted for above.
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    noteFailure(opName, "network/fetch failed", { error: message });
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

export async function getLinkDiagnostics(): Promise<LinkDiagnostics> {
  const response = await rvFetch(
    `${apiBase}/diagnostics/link`,
    { cache: "no-store" },
    "diagnostics:link"
  );
  return response.json();
}

export async function getSubcarrierDiagnostics(): Promise<SubcarrierDiagnostics> {
  const response = await rvFetch(
    `${apiBase}/diagnostics/subcarriers`,
    { cache: "no-store" },
    "diagnostics:subcarriers"
  );
  return response.json();
}

export async function getLatestFrames(sessionId: string, n = 50): Promise<{
  session_id: string;
  count: number;
  frames: RawFrame[];
}> {
  const response = await rvFetch(
    `${apiBase}/sessions/${sessionId}/frames/latest?n=${n}`,
    { cache: "no-store" },
    `sessions:frames:latest[${sessionId}]`
  );
  return response.json();
}

export async function getRoomGeometry(): Promise<RoomGeometry> {
  const response = await rvFetch(
    `${apiBase}/room/geometry`,
    { cache: "no-store" },
    "room:geometry:get"
  );
  return response.json();
}

export async function putRoomGeometry(geometry: RoomGeometry): Promise<RoomGeometry> {
  const response = await rvFetch(
    `${apiBase}/room/geometry`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(geometry),
    },
    "room:geometry:put"
  );
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
/**
 * Returned by connectLive(). Callers can re-subscribe at any time to add
 * topics like "raw_frame" beyond the default "derived_window".
 */
export interface LiveConnection {
  close: () => void;
  subscribe: (topics: string[]) => void;
}

export function connectLive(
  onMessage: (message: LiveMessage) => void,
  onStatus: (status: string) => void,
  options: { topics?: string[] } = {}
): LiveConnection {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let desiredTopics: string[] = options.topics ? [...options.topics] : ["derived_window"];
  const tickRecv = makeRateCounter("ws", "frames received");

  const sendSubscribe = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "subscribe", topics: desiredTopics }));
      devlog.info("ws", `subscribed to topics: ${desiredTopics.join(", ")}`);
    } catch (err) {
      devlog.warn("ws", "subscribe send failed", { error: err });
    }
  };

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
      // Always declare the desired topic list on connect so reconnects
      // do not silently drop a "raw_frame" subscription.
      sendSubscribe();
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

  return {
    close: () => {
      stopped = true;
      devlog.info("ws", "client requested disconnect");
      if (retry) globalThis.clearTimeout(retry);
      socket?.close();
    },
    subscribe: (topics: string[]) => {
      desiredTopics = [...topics];
      sendSubscribe();
    },
  };
}
