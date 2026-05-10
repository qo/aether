import type { ReactNode } from "react";
import type { SourceMode } from "../lib/types";

/*
 * The DisconnectedBanner is the single, prominent place the Live Room tells
 * the operator WHY they're not seeing data and WHAT to do about it. The
 * console (features/aether-console.tsx) computes a reason code based
 * on the WS state, the source mode, the configured serial port, and whether
 * an active session exists. We map that code to:
 *
 *   - a tone (info / warning / danger) which controls the banner colour
 *   - a headline (one short sentence, what is happening)
 *   - a guidance line (one sentence, what to do next)
 *   - an optional inline action (e.g. Start Session)
 *
 * The banner is intentionally NOT clever: it is a dumb mapping from reason
 * code to copy. All the truth-seeking logic lives in the console so this
 * component can be unit-tested by passing a reason in.
 */

export type DisconnectedReason =
  | "ws_connecting"
  | "ws_error"
  | "ws_dropped"
  | "api_offline"
  | "no_serial_port"
  | "no_session"
  | "session_starting"
  | "no_frames_yet";

interface BannerProps {
  status: string;
  reason?: DisconnectedReason;
  serialPort?: string | null;
  sourceMode?: SourceMode | null;
  errorDetail?: string | null;
  starting?: boolean;
  onStartSession?: () => void;
}

interface CopyEntry {
  tone: "info" | "warning" | "danger";
  title: string;
  message: ReactNode;
  action?: { label: string; kind: "primary" | "secondary"; intent: "start_session" };
}

function buildCopy(props: BannerProps): CopyEntry {
  const { reason, status, serialPort, sourceMode } = props;
  switch (reason) {
    case "ws_connecting":
      return {
        tone: "info",
        title: "Connecting to the host service…",
        message: "Reaching the API at /ws/live. If this never resolves, check that uvicorn is running."
      };
    case "ws_error":
      return {
        tone: "danger",
        title: "WebSocket error.",
        message: "The browser opened the connection then dropped. Look at the API logs for [ws] !! handler raised."
      };
    case "ws_dropped":
      return {
        tone: "warning",
        title: "WebSocket dropped (HTTP still works).",
        message: (
          <>
            REST polls are succeeding but the live stream socket is closed. In dev this is almost
            always a Turbopack <code>ChunkLoadError</code> from a stale <code>.next</code> cache.
            Stop <code>next dev</code>, delete <code>apps/web/.next</code>, then restart.
          </>
        )
      };
    case "api_offline":
      return {
        tone: "danger",
        title: "API is unreachable.",
        message: (
          <>
            No response from the host service. Start it with{" "}
            <code>python -m uvicorn apps.api.src.main:app --reload</code> and refresh.
          </>
        )
      };
    case "no_serial_port":
      return {
        tone: "warning",
        title: "Serial port not configured.",
        message: (
          <>
            Source mode is <code>{sourceMode ?? "LIVE"}</code> but{" "}
            <code>AETHER_SERIAL_PORT</code> is unset, so the collector cannot read from the
            RX board. Set it (e.g. <code>$env:AETHER_SERIAL_PORT = &quot;COM5&quot;</code> on
            Windows, <code>/dev/ttyUSB0</code> on Linux) and restart the API.
          </>
        )
      };
    case "session_starting":
      return {
        tone: "info",
        title: "Starting session…",
        message: "Opening the serial port and warming up the DSP. First derived window arrives once 10 frames are buffered."
      };
    case "no_session":
      return {
        tone: "warning",
        title: "No active session.",
        message: (
          <>
            Connection is live ({status}) but no session has been started.{" "}
            {serialPort ? (
              <>
                Serial <code>{serialPort}</code> is configured. Click <strong>Start session</strong> to begin recording.
              </>
            ) : (
              <>Configure a serial port first, then start a session.</>
            )}
          </>
        ),
        action: { label: "Start session", kind: "primary", intent: "start_session" }
      };
    case "no_frames_yet":
      return {
        tone: "warning",
        title: "Session running but no CSI frames received.",
        message: (
          <>
            The serial port opened but no CSI packets have arrived yet. Check the API logs for{" "}
            <code>[runtime] collector heartbeat</code>; if you don&apos;t see one within ~5 s, the RX board
            firmware is not emitting CSI on this port/baud.
          </>
        )
      };
    default:
      return {
        tone: "warning",
        title: "Stream not flowing.",
        message: `Connection status: ${status}. Use the Devices page to confirm host service health.`
      };
  }
}

export function DisconnectedBanner(props: BannerProps) {
  const { errorDetail, starting, onStartSession } = props;
  const copy = buildCopy(props);

  return (
    <div className={`disconnectedBanner tone-${copy.tone}`} role="alert">
      <div className="disconnectedBannerCopy">
        <strong>{copy.title}</strong>
        <span>{copy.message}</span>
        {errorDetail ? (
          <span className="disconnectedBannerError">{errorDetail}</span>
        ) : null}
      </div>
      {starting ? (
        <span className="disconnectedBannerSpinner">starting…</span>
      ) : copy.action && onStartSession ? (
        <button
          type="button"
          className={copy.action.kind === "primary" ? "primaryButton" : "secondaryButton"}
          onClick={onStartSession}
        >
          {copy.action.label}
        </button>
      ) : null}
    </div>
  );
}
