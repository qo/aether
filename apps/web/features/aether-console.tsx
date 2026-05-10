"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Bell, RefreshCw, Square, Waves } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AmplitudeChart } from "../components/amplitude-chart";
import { ConfidenceBadge } from "../components/confidence-badge";
import { DataTable } from "../components/data-table";
import { DisconnectedBanner } from "../components/disconnected-banner";
import type { DisconnectedReason } from "../components/disconnected-banner";
import { EmptyState } from "../components/empty-state";
import { EventTag } from "../components/event-tag";
import { MetricCard } from "../components/metric-card";
import { SectionHeader } from "../components/section-header";
import { SourceBadge } from "../components/source-badge";
import { StatusDot } from "../components/status-dot";
import { SubcarrierBars } from "../components/subcarrier-bars";
import { SubcarrierTimeMap } from "../components/spectrogram";
import { TrendChart, type TrendSeries } from "../components/trend-chart";
import {
  addSessionEvent,
  cancelCalibration,
  connectLive,
  createSession,
  getCalibrationStatus,
  getDevices,
  getHealth,
  getRoomSummary,
  getSessionSummary,
  getSessions,
  listPresets,
  resetCalibration,
  startCalibration,
  startPreset,
  startSession,
  stopSession,
  type DemoPreset
} from "../lib/api";
import type { CalibrationStatus, DerivedWindow, RoomSummary, SessionRecord, SourceMode } from "../lib/types";

const navSections = [
  { label: "MONITORING", items: ["Live Room", "Devices"] },
  { label: "RESEARCH", items: ["Experiment Console", "Data Explorer"] },
  { label: "KNOWLEDGE", items: ["Knowledge Base", "Agent Console"] },
  { label: "SYSTEM", items: ["Settings"] }
] as const;

type PageName = (typeof navSections)[number]["items"][number];

const trendSeries: TrendSeries[] = [
  { label: "Motion", stroke: "#14B8A6", pick: (w) => w.motion_score },
  { label: "Occupancy", stroke: "#3B82F6", pick: (w) => w.occupancy_score },
  { label: "Anomaly /18", stroke: "#F59E0B", pick: (w) => w.anomaly_score / 18 },
  { label: "Quality", stroke: "#22C55E", pick: (w) => w.quality_score, dash: [4, 3] }
];

const biorhythmSeries: TrendSeries[] = [
  { label: "Respiration (bpm)", stroke: "#14B8A6", pick: (w) => w.respiration_bpm, scale: "bpm" },
  { label: "Motion peak 0.8–2.5 Hz", stroke: "#EF4444", pick: (w) => w.heart_rate_proxy_bpm, scale: "bpm" },
  { label: "Resp confidence", stroke: "#3B82F6", pick: (w) => w.respiration_confidence ?? null, dash: [4, 3] },
  { label: "Motion-peak confidence", stroke: "#F59E0B", pick: (w) => w.heart_rate_proxy_confidence ?? null, dash: [4, 3] }
];

const protocolDefinitions = [
  {
    id: "empty_room_baseline",
    title: "Empty room baseline",
    purpose: "Capture baseline signal quality without people moving near the link.",
    success: "Stable packet rate, RSSI, and low anomaly score."
  },
  {
    id: "human_presence_static",
    title: "Human presence static",
    purpose: "Compare occupied stillness against empty-room baseline.",
    success: "Occupancy score separates from baseline with acceptable quality."
  },
  {
    id: "cross_line_of_sight",
    title: "Cross line of sight",
    purpose: "Measure motion response when a person crosses between boards.",
    success: "Motion score rises during labeled crossing windows."
  },
  {
    id: "seated_breathing_exploration",
    title: "Seated breathing exploration",
    purpose: "Research-only respiration feasibility after link validation.",
    success: "Only report respiration if confidence is returned by the backend."
  }
];

function isPageName(value: string | null | undefined): value is PageName {
  if (!value) return false;
  return navSections.some((section) => (section.items as readonly string[]).includes(value));
}

export function RadioVisionConsole() {
  // Sub-page state is driven by the global shell's sidebar via ?page=… so
  // links like "/home?page=Experiment+Console" route within the console
  // without a full reload.
  const searchParams = useSearchParams();
  const queryPage = searchParams?.get("page") ?? null;
  const initialPage: PageName = isPageName(queryPage) ? queryPage : "Live Room";
  const [page, setPage] = useState<PageName>(initialPage);
  useEffect(() => {
    if (isPageName(queryPage) && queryPage !== page) {
      setPage(queryPage);
    }
  }, [queryPage, page]);
  const [connectionStatus, setConnectionStatus] = useState("offline");
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(null);
  const [windows, setWindows] = useState<DerivedWindow[]>([]);
  const [summary, setSummary] = useState<RoomSummary | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingSession, setStartingSession] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationStatus | null>(null);
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  /*
   * apiReachable is the truth about HTTP. It's set to true whenever any
   * REST call succeeds and false when one throws. WebSocket state lives in
   * connectionStatus and is INDEPENDENT - it is normal in dev for the WS to
   * drop (ChunkLoadError, hot reload) while HTTP keeps working perfectly.
   * Conflating them produces the "API unreachable" lie the operator sees
   * even though uvicorn logs show 200s every five seconds.
   *
   * Optimistic default: true. The first failed poll flips it false and the
   * banner takes over. The next successful poll flips it back.
   */
  const [apiReachable, setApiReachable] = useState<boolean>(true);
  // Auto-start gate. Once the operator has pressed Stop (or auto-start has
  // already fired on this page load), don't keep re-starting in a loop. Also
  // suppresses auto-start if the backend keeps reporting a serial error so
  // we don't hammer /sessions every poll.
  const autoStartedRef = useRef(false);
  const userStoppedRef = useRef(false);
  /*
   * wallClockMs ticks every 1 s purely so the "is the board streaming right
   * now?" derivations re-evaluate. Without this, latest_window_age_seconds
   * would only update when a new window arrives - which is exactly the
   * moment we don't care about because the screen would already be lying
   * during a stall.
   *
   * Initialised to 0 (not Date.now()) so SSR and the client's first render
   * compute identical strings. Date.now() in a useState initializer is a
   * classic hydration-mismatch vector: the server captures one timestamp,
   * the browser captures another a few ms later, and any rendered string
   * derived from it diverges. The actual wall clock is set in the useEffect
   * below, after hydration is done.
   */
  const [wallClockMs, setWallClockMs] = useState<number>(0);

  const serialPort = useMemo(() => {
    const rx = (devices?.rx ?? null) as Record<string, unknown> | null;
    const value = rx?.serial_port;
    return typeof value === "string" && value.length > 0 ? value : null;
  }, [devices]);
  // Backend-reported source error (e.g. "could not open port 'COM10'"). The
  // serial reader retries internally, so this is informational, not fatal —
  // but the user needs to see it or they'll think Start did nothing.
  const sourceError = useMemo(() => {
    const rx = (devices?.rx ?? null) as Record<string, unknown> | null;
    const value = rx?.last_error;
    return typeof value === "string" && value.length > 0 ? value : null;
  }, [devices]);

  useEffect(() => {
    void refreshMetadata();
    const conn = connectLive(
      (message) => {
        if (message.summary) {
          setSummary(message.summary);
          setSourceMode(message.summary.source_mode ?? null);
        }
        if (message.window) {
          setWindows((current) => [...current.slice(-160), message.window as DerivedWindow]);
          setSourceMode(message.window.source_mode);
        }
      },
      setConnectionStatus
    );
    const poll = window.setInterval(() => void refreshRuntimeSnapshot(), 5000);
    // Seed the wall clock immediately on mount so latestWindowAgeSec stops
    // returning null after hydration; the interval keeps it fresh.
    setWallClockMs(Date.now());
    const tick = window.setInterval(() => setWallClockMs(Date.now()), 1000);
    return () => {
      conn.close();
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  async function refreshMetadata() {
    try {
      const [health, devicePayload, sessionPayload] = await Promise.all([getHealth(), getDevices(), getSessions()]);
      setSourceMode(health.source_mode);
      setDevices(devicePayload);
      setSessions(sessionPayload);
      const active = sessionPayload.find((session) => session.started_ns && !session.stopped_ns);
      setActiveSessionId(active?.session_id ?? null);
      setApiReachable(true);
      setError(null);
    } catch (caught) {
      // HTTP failed → API really is down. WS state is unrelated and is owned
      // by connectLive's onStatus callback; do NOT touch connectionStatus here.
      setApiReachable(false);
      setError(caught instanceof Error ? caught.message : "API unavailable");
    }
  }

  async function refreshRuntimeSnapshot() {
    try {
      const [health, room, cal] = await Promise.all([
        getHealth(),
        getRoomSummary(),
        getCalibrationStatus().catch(() => null)
      ]);
      setSourceMode(health.source_mode);
      setSummary(room as RoomSummary);
      if (cal) setCalibration(cal);
      setApiReachable(true);
      setError(null);
    } catch (caught) {
      setApiReachable(false);
      setError(caught instanceof Error ? caught.message : "API unavailable");
    }
  }

  async function runCalibration(seconds = 10) {
    if (calibrationBusy) return;
    setCalibrationBusy(true);
    try {
      const status = await startCalibration(seconds);
      setCalibration(status);
      // Poll a few times while calibration runs.
      const start = Date.now();
      while (Date.now() - start < (seconds + 4) * 1000) {
        await new Promise((r) => setTimeout(r, 750));
        const next = await getCalibrationStatus();
        setCalibration(next);
        if (!next.is_calibrating) break;
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Calibration failed");
    } finally {
      setCalibrationBusy(false);
    }
  }

  async function clearCalibration() {
    if (calibrationBusy) return;
    setCalibrationBusy(true);
    try {
      const status = await resetCalibration();
      setCalibration(status);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Calibration reset failed");
    } finally {
      setCalibrationBusy(false);
    }
  }

  async function abortCalibration() {
    if (calibrationBusy) return;
    setCalibrationBusy(true);
    try {
      const status = await cancelCalibration();
      setCalibration(status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Calibration cancel failed");
    } finally {
      setCalibrationBusy(false);
    }
  }

  const latest = windows.at(-1) ?? null;
  const activeSession = sessions.find((session) => session.session_id === activeSessionId) ?? null;
  const hasSession = Boolean(activeSession);

  /*
   * Truth signals — replace the old "WS connected = board connected" lie.
   *
   *   framesEverReceived: did we get at least one derived window since page load?
   *   latestWindowAgeSec: how long ago, in seconds (host wall clock), the most
   *                       recent window arrived. Recomputes every second
   *                       because wallClockMs ticks. Null if no window yet.
   *   recentFramePerSec : windows-per-second over the last ~5 windows. Lets the
   *                       overview show "20 Hz" or "0 Hz".
   *   boardStreaming    : true iff a window arrived in the last 3 s. This is
   *                       the signal the Devices page should use to decide
   *                       whether the RX board is "alive".
   */
  const framesEverReceived = windows.length > 0;
  // wallClockMs === 0 means we have not mounted yet (SSR or pre-effect),
  // so we cannot compute a meaningful age. Return null so the rendered
  // string is identical on server and client.
  const latestWindowAgeSec = latest && wallClockMs > 0
    ? Math.max(0, (wallClockMs - latest.window_end_ns / 1e6) / 1000)
    : null;
  const recentFramePerSec = useMemo(() => {
    if (windows.length < 2) return null;
    const tail = windows.slice(-Math.min(windows.length, 6));
    const span = (tail[tail.length - 1].window_end_ns - tail[0].window_end_ns) / 1e9;
    if (span <= 0) return null;
    return (tail.length - 1) / span;
  }, [windows]);
  const boardStreaming = latestWindowAgeSec != null && latestWindowAgeSec < 3;

  /*
   * Auto-start: as soon as the API is reachable, the WS is connected, the
   * source is configured (serial port for LIVE, or REPLAY mode), and there
   * is no active session, we kick off a session for the operator. This is
   * what they expect — the audit feedback was "I plugged everything in,
   * why do I need to press a button?".
   *
   * Guards:
   *   - autoStartedRef: only ever fires once per page load, even if the
   *     gates flap (e.g. WS reconnects).
   *   - userStoppedRef: if the operator hit Stop, we DO NOT auto-restart.
   *     They can re-start manually with the Start button.
   *   - sourceError: if the backend just told us the serial open failed,
   *     don't loop POSTing /sessions/start every render. The retry logic
   *     in read_serial_frames will re-open on its own.
   */
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (userStoppedRef.current) return;
    if (!apiReachable) return;
    if (connectionStatus !== "connected") return;
    if (hasSession) return;
    if (startingSession) return;
    if (sourceError) return; // wait for the operator to fix the port
    const sourceReady = sourceMode === "REPLAY" || Boolean(serialPort);
    if (!sourceReady) return;
    autoStartedRef.current = true;
    void quickStartSession();
    // quickStartSession is stable for this scope; effect only depends on the
    // gate values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReachable, connectionStatus, hasSession, startingSession, sourceMode, serialPort, sourceError]);

  const disconnected = !boardStreaming;
  /*
   * Reason priority (highest first). Each rung answers a different "why
   * isn't there data?" question. Critically, !apiReachable (HTTP) is a
   * separate problem from WS state - we used to say "API offline" whenever
   * the WS dropped, which lied during dev hot-reload.
   */
  const disconnectedReason: DisconnectedReason | undefined =
    !apiReachable
      ? "api_offline"
      : connectionStatus === "connecting"
      ? "ws_connecting"
      : connectionStatus === "error"
      ? "ws_error"
      : connectionStatus !== "connected"
      ? "ws_dropped"
      : sourceMode === "LIVE" && !serialPort
      ? "no_serial_port"
      : startingSession
      ? "session_starting"
      : !hasSession
      ? "no_session"
      : !framesEverReceived
      ? "session_starting"
      : "no_frames_yet";

  return (
    <div className="appShell">
      <section className="mainPane">
        <TopBar page={page} activeSession={activeSession} sourceMode={sourceMode} onStop={() => void stopActiveSession()} />
        <div className="contentWrap">
          <PageHeader page={page} />
          {page === "Live Room" ? (
            <LiveRoom
              latest={latest}
              windows={windows}
              summary={summary}
              disconnected={disconnected}
              disconnectedReason={disconnectedReason}
              connectionStatus={connectionStatus}
              serialPort={serialPort}
              sourceMode={sourceMode}
              startError={error}
              sourceError={sourceError}
              starting={startingSession}
              boardStreaming={boardStreaming}
              framesEverReceived={framesEverReceived}
              latestWindowAgeSec={latestWindowAgeSec}
              recentFramePerSec={recentFramePerSec}
              hasSession={hasSession}
              apiReachable={apiReachable}
              onRefresh={() => void refreshMetadata()}
              onStartSession={() => void quickStartSession()}
              onStopSession={() => void stopActiveSession()}
              calibration={calibration}
              calibrationBusy={calibrationBusy}
              onCalibrate={(seconds) => void runCalibration(seconds)}
              onCalibrationReset={() => void clearCalibration()}
              onCalibrationCancel={() => void abortCalibration()}
            />
          ) : null}
          {page === "Devices" ? (
            <Devices
              devices={devices}
              sourceMode={sourceMode}
              connectionStatus={connectionStatus}
              boardStreaming={boardStreaming}
              framesEverReceived={framesEverReceived}
              latestWindowAgeSec={latestWindowAgeSec}
              recentFramePerSec={recentFramePerSec}
            />
          ) : null}
          {page === "Experiment Console" ? (
            <ExperimentConsole
              activeSession={activeSession}
              latest={latest}
              onCreated={(session) => {
                setSessions((current) => [session, ...current.filter((item) => item.session_id !== session.session_id)]);
                setActiveSessionId(session.session_id);
              }}
              onRefresh={() => void refreshMetadata()}
            />
          ) : null}
          {page === "Data Explorer" ? <DataExplorer sessions={sessions} latest={latest} /> : null}
          {page === "Knowledge Base" ? <KnowledgeBase /> : null}
          {page === "Agent Console" ? <AgentConsole sourceMode={sourceMode} activeSession={activeSession} /> : null}
          {page === "Settings" ? <SettingsPage /> : null}
        </div>
      </section>
    </div>
  );

  async function stopActiveSession() {
    if (!activeSessionId) return;
    // Mark explicit stop so the auto-start effect doesn't immediately
    // re-create a session on the next render. Until the operator presses
    // Start manually, the Live Room stays idle.
    userStoppedRef.current = true;
    try {
      await stopSession(activeSessionId);
      setActiveSessionId(null);
      await refreshMetadata();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to stop session");
    }
  }

  async function quickStartSession() {
    if (startingSession) return;
    // Manual click clears the user-stopped flag so the auto-start gate
    // can fire again on the next reconnect (e.g. after the operator
    // toggled the port off/on).
    userStoppedRef.current = false;
    setStartingSession(true);
    try {
      const session = await createSession({ protocol: "human_presence_static", notes: "quick-start" });
      setSessions((prev) => [session, ...prev.filter((s) => s.session_id !== session.session_id)]);
      setActiveSessionId(session.session_id);
      const started = await startSession(session.session_id);
      setSessions((prev) => prev.map((s) => (s.session_id === started.session_id ? started : s)));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to start session");
    } finally {
      setStartingSession(false);
    }
  }
}

// The legacy in-console Sidebar was removed when the global app shell took
// over navigation; sub-page selection now flows through ?page=… read at the
// top of RadioVisionConsole. The TopBar below is repurposed as an in-content
// session-control strip.

function TopBar({
  page,
  activeSession,
  sourceMode,
  onStop
}: {
  page: string;
  activeSession: SessionRecord | null;
  sourceMode: SourceMode | null;
  onStop: () => void;
}) {
  return (
    <header className="topbar">
      <div className="breadcrumb">Aether / {page}</div>
      <div className="topbarRight">
        {/*
          Quick-jump links to the new routes added in v0.2 (Phase D/E).
          These intentionally bypass the in-page navSections setPage() flow
          because they're real routes — back button works, can be popped out,
          and survive a refresh.
        */}
        <a href="/raw" className="iconButton" style={{ textDecoration: "none" }}>Raw</a>
        <a href="/3d" className="iconButton" style={{ textDecoration: "none" }}>3D</a>
        <a href="/devices-v2" className="iconButton" style={{ textDecoration: "none" }}>Geometry</a>
        <span className="sessionName">{activeSession?.protocol ?? "No active session"}</span>
        <SourceBadge mode={sourceMode} />
        {activeSession ? (
          <button className="dangerButton" onClick={onStop} type="button">
            <Square size={14} /> Stop
          </button>
        ) : (
          <button className="primaryButton" type="button" disabled>
            Record
          </button>
        )}
        <button className="iconButton" aria-label="System alerts" type="button">
          <Bell size={16} />
        </button>
      </div>
    </header>
  );
}

function PageHeader({ page }: { page: string }) {
  const subtitles: Record<string, string> = {
    "Live Room": "Realtime CSI monitoring from live or replay streams.",
    Devices: "Board and host-service connection state.",
    "Experiment Console": "Create sessions and write timestamped experiment labels.",
    "Data Explorer": "Inspect stored sessions through the currently exposed API.",
    "Knowledge Base": "Documentation search is not exposed by the current API.",
    "Agent Console": "Grounded agent output is unavailable until tool results are exposed.",
    Settings: "Runtime configuration and operator guidance."
  };
  return (
    <div className="pageHeader">
      <div>
        <h1>{page}</h1>
        <p>{subtitles[page]}</p>
      </div>
    </div>
  );
}

function LiveRoom({
  latest,
  windows,
  summary,
  disconnected,
  disconnectedReason,
  connectionStatus,
  serialPort,
  sourceMode,
  startError,
  sourceError,
  starting,
  boardStreaming,
  framesEverReceived,
  latestWindowAgeSec,
  recentFramePerSec,
  hasSession,
  apiReachable,
  onRefresh,
  onStartSession,
  onStopSession,
  calibration,
  calibrationBusy,
  onCalibrate,
  onCalibrationReset,
  onCalibrationCancel
}: {
  latest: DerivedWindow | null;
  windows: DerivedWindow[];
  summary: RoomSummary | null;
  disconnected: boolean;
  disconnectedReason?: DisconnectedReason;
  connectionStatus: string;
  serialPort: string | null;
  sourceMode: SourceMode | null;
  startError: string | null;
  sourceError: string | null;
  starting: boolean;
  boardStreaming: boolean;
  framesEverReceived: boolean;
  latestWindowAgeSec: number | null;
  recentFramePerSec: number | null;
  hasSession: boolean;
  apiReachable: boolean;
  onRefresh: () => void;
  onStartSession: () => void;
  onStopSession: () => void;
  calibration: CalibrationStatus | null;
  calibrationBusy: boolean;
  onCalibrate: (seconds: number) => void;
  onCalibrationReset: () => void;
  onCalibrationCancel: () => void;
}) {
  const vital = deriveVitalSummary(latest);
  // Gate the heavy visualisation grid (5 charts + 8 cards) behind "we have
  // ever seen a window". Otherwise the page is 15 empty cards on first load,
  // which is what the operator was complaining about.
  const showDataGrid = framesEverReceived;
  // The previous layout rendered every card at once in a 3-column wall. With
  // 13+ cards plus 5 charts, the page was visually overwhelming and the
  // browser had to re-render every chart on each window arrival. The tabbed
  // layout below keeps each tab to ~3-4 cards so only that tab's charts
  // re-render — meaningfully less work per WS message.
  const calibrated = Boolean(calibration?.is_calibrated || latest?.baseline_calibrated);
  const incident = useMemo(() => deriveIncidentState(windows), [windows]);
  const [roomTab, setRoomTab] = useState<RoomTabId>("overview");
  const tabDefs = ROOM_TABS;
  return (
    <div className="pageStack">
      <LiveControlBar
        apiReachable={apiReachable}
        connectionStatus={connectionStatus}
        sourceMode={sourceMode}
        serialPort={serialPort}
        hasSession={hasSession}
        boardStreaming={boardStreaming}
        framesEverReceived={framesEverReceived}
        latestWindowAgeSec={latestWindowAgeSec}
        recentFramePerSec={recentFramePerSec}
        starting={starting}
        // sourceError beats startError: a stale POST error matters less than
        // a still-failing serial open.
        startError={sourceError ?? startError}
        onStart={onStartSession}
        onStop={onStopSession}
        onRefresh={onRefresh}
      />
      {!showDataGrid ? (
        <ReadinessChecklist
          apiReachable={apiReachable}
          connectionStatus={connectionStatus}
          sourceMode={sourceMode}
          serialPort={serialPort}
          hasSession={hasSession}
          boardStreaming={boardStreaming}
          framesEverReceived={framesEverReceived}
          calibrated={calibrated}
        />
      ) : null}
      {disconnected && disconnectedReason !== "no_session" ? (
        // The "no_session" reason is fully covered by the LiveControlBar
        // Start button; showing the same prompt twice is exactly the kind
        // of clutter the operator flagged. Other reasons (api_offline,
        // no_serial_port, no_frames_yet, etc.) still get the banner because
        // they need their own copy.
        <DisconnectedBanner
          status={connectionStatus}
          reason={disconnectedReason}
          serialPort={serialPort}
          sourceMode={sourceMode}
          errorDetail={startError}
          starting={starting}
          onStartSession={onStartSession}
        />
      ) : null}
      {!showDataGrid ? (
        <section className="liveRoomEmpty">
          <EmptyState
            title={
              hasSession
                ? "Session running — waiting for first derived window"
                : "Press Start above to begin streaming"
            }
            message={
              hasSession
                ? "The DSP needs ~10 buffered raw frames before it emits a window. Watch the API logs for [runtime] collector heartbeat to confirm CSI is arriving."
                : sourceMode === "REPLAY"
                ? "Start opens the replay file and feeds frames at the configured rate."
                : `Start opens the serial port (${serialPort ?? "AETHER_SERIAL_PORT unset"}) and reads CSI from the RX board.`
            }
          />
        </section>
      ) : null}
      {showDataGrid ? (
        <>
          <nav className="roomTabs" role="tablist" aria-label="Live room views">
            {tabDefs.map((tab) => {
              const active = tab.id === roomTab;
              const badge =
                tab.id === "diagnostics" && !calibrated
                  ? "needs cal"
                  : tab.id === "movement" && incident.state === "suspected"
                  ? "alert"
                  : null;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`roomTab${active ? " roomTab--active" : ""}`}
                  onClick={() => setRoomTab(tab.id)}
                >
                  <span className="roomTabLabel">{tab.label}</span>
                  <span className="roomTabHint">{tab.hint}</span>
                  {badge ? <span className={`roomTabBadge roomTabBadge--${badge === "alert" ? "danger" : "warn"}`}>{badge}</span> : null}
                </button>
              );
            })}
          </nav>
          {roomTab === "overview" ? (
            <section className="roomPanel roomPanel--two">
              <div className="columnStack">
                <DeviceStatusCard
                  latest={latest}
                  serialPort={serialPort}
                  boardStreaming={boardStreaming}
                  framesEverReceived={framesEverReceived}
                  latestWindowAgeSec={latestWindowAgeSec}
                  recentFramePerSec={recentFramePerSec}
                />
                <SessionCard latest={latest} />
                <SignalQualityCard latest={latest} />
                <RoomSummaryCard summary={summary} />
              </div>
              <div className="columnStack">
                <Card title="Live Trends" sourceMode={latest?.source_mode ?? null}>
                  <TrendChart
                    windows={windows}
                    ariaLabel="Motion, occupancy, anomaly, and quality trend"
                    series={trendSeries}
                    height={280}
                  />
                </Card>
                <IncidentCard incident={incident} latest={latest} />
              </div>
            </section>
          ) : null}
          {roomTab === "vitals" ? (
            <section className="roomPanel roomPanel--two">
              <div className="columnStack">
                <RespirationCard latest={latest} windows={windows} vital={vital} />
                <HeartBandCard latest={latest} windows={windows} vital={vital} />
                <GaitCard latest={latest} windows={windows} />
                <FidgetEnergyCard latest={latest} windows={windows} />
              </div>
              <div className="columnStack">
                <Card title="Biorhythm Spectrum" sourceMode={latest?.source_mode ?? null} researchOnly>
                  <TrendChart
                    windows={windows}
                    ariaLabel="Respiration and heart-rate proxy trend"
                    series={biorhythmSeries}
                    height={240}
                  />
                  <BiorhythmStatus latest={latest} />
                </Card>
                <p className="researchNote">
                  These are <strong>motion-band periodicities</strong>, not vital signs. The 0.8–2.5 Hz peak is the
                  strongest periodic motion in that band — on PCB antennas at 2 m it is most often a respiration
                  harmonic, walking cadence, or hardware drift, not cardiac micro-motion. Treat every reading as
                  <code>[Inference]</code>; we display a number only when stillness, FFT/ACF agreement, and harmonic
                  checks all pass.
                </p>
              </div>
            </section>
          ) : null}
          {roomTab === "movement" ? (
            <section className="roomPanel roomPanel--two">
              <div className="columnStack">
                <IncidentCard incident={incident} latest={latest} />
                <GaitCard latest={latest} windows={windows} />
                <MetricCard
                  title="Motion score"
                  value={latest ? latest.motion_score.toFixed(2) : null}
                  detail="Backend-derived motion energy. Spikes on near-link motion."
                  confidence={confidenceFrom(latest?.quality_score)}
                  sparkline={windows.map((window) => window.motion_score)}
                />
                <MetricCard
                  title="Occupancy score"
                  value={latest ? latest.occupancy_score.toFixed(2) : null}
                  detail={
                    latest?.baseline_calibrated
                      ? "Anomaly-vs-baseline score. Backend-derived."
                      : "Uncalibrated — run baseline before reading this."
                  }
                  confidence={confidenceFrom(latest?.quality_score)}
                  sparkline={windows.map((window) => window.occupancy_score)}
                />
              </div>
              <div className="columnStack">
                <Card title="Motion / occupancy / anomaly" sourceMode={latest?.source_mode ?? null}>
                  <TrendChart
                    windows={windows}
                    ariaLabel="Motion, occupancy, and anomaly trend"
                    series={trendSeries.filter((series) => series.label !== "Quality")}
                    height={280}
                  />
                </Card>
              </div>
            </section>
          ) : null}
          {roomTab === "subcarriers" ? (
            <section className="roomPanel roomPanel--single">
              <Card title="Subcarrier Amplitude" sourceMode={latest?.source_mode ?? null}>
                <AmplitudeChart windows={windows} />
              </Card>
              <Card title="Subcarrier Responsiveness" sourceMode={latest?.source_mode ?? null}>
                <SubcarrierBars windows={windows} metric="amplitude_std" />
                <small style={{ color: "var(--text-muted)" }}>
                  Mean amplitude std per subcarrier across the last 30 windows. Tall bars = subcarriers most disturbed by
                  the body in the link.
                </small>
              </Card>
              <Card title="Subcarrier-time map" sourceMode={latest?.source_mode ?? null}>
                <SubcarrierTimeMap windows={windows} height={220} />
                <small style={{ color: "var(--text-muted)" }}>
                  Rows = subcarriers, columns = windows over time, intensity = amplitude std. Real respiration shows up
                  as a few adjacent rows pulsing in lockstep; broadband motion paints the whole map.
                </small>
              </Card>
            </section>
          ) : null}
          {roomTab === "diagnostics" ? (
            <section className="roomPanel roomPanel--two">
              <div className="columnStack">
                <CalibrationCard
                  latest={latest}
                  calibration={calibration}
                  busy={calibrationBusy}
                  onCalibrate={onCalibrate}
                  onReset={onCalibrationReset}
                  onCancel={onCalibrationCancel}
                />
                <DemoPresetCard />
                <LatencyBudgetCard latest={latest} windows={windows} />
                <RoomSummaryCard summary={summary} />
              </div>
              <div className="columnStack">
                <Card title="Quality trend" sourceMode={latest?.source_mode ?? null}>
                  <TrendChart
                    windows={windows}
                    ariaLabel="Signal quality and motion trend"
                    series={trendSeries.filter((s) => s.label === "Quality" || s.label === "Motion")}
                    height={220}
                  />
                </Card>
                <Card title="Deeper inspection">
                  <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
                    For per-frame I/Q, link inter-arrival p99/jitter, and live subcarrier amplitude/phase, open the
                    Raw inspector in the top-right.
                  </p>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <a href="/raw" className="iconButton" style={{ textDecoration: "none" }}>Open Raw Inspector</a>
                    <a href="/3d" className="iconButton" style={{ textDecoration: "none" }}>Open 3D Geometry</a>
                  </div>
                </Card>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ---------- Tab definitions ---------- */

type RoomTabId = "overview" | "vitals" | "movement" | "subcarriers" | "diagnostics";
const ROOM_TABS: { id: RoomTabId; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "device · session · trends" },
  { id: "vitals", label: "Periodic Motion", hint: "respiration · motion peaks · fidget" },
  { id: "movement", label: "Movement", hint: "motion · occupancy · incidents" },
  { id: "subcarriers", label: "Subcarriers", hint: "amplitude · responsiveness" },
  { id: "diagnostics", label: "Diagnostics", hint: "calibration · link · raw" },
];

/* ---------- Incident inference ---------- */

type IncidentState = "idle" | "spike" | "post-spike-still" | "suspected";
type IncidentReading = {
  state: IncidentState;
  detail: string;
  spikeMotion: number | null;
  recentMotion: number | null;
  stillSeconds: number;
  windowsUsed: number;
};

/*
 * Hysteretic fall/incident inference. NOT medical-grade. CSI motion is a
 * pure derived signal — we cannot tell a person from a pet from a falling
 * object. The classifier is a small state machine:
 *
 *   idle         -> spike when motion crosses the SPIKE threshold
 *   spike        -> post-spike-still once motion drops below STILL
 *   post-still   -> suspected after STILL persists for SUSTAINED_S
 *   suspected    -> stays suspected until motion crosses SPIKE again
 *                   (then back to spike) or RESET_S elapses with motion
 *                   confirmed normal (then back to idle)
 *
 * The big change vs. the previous threshold-only version:
 *  - State persists across windows; "suspected" requires SUSTAINED stillness,
 *    not a single quiet half-window. False positives drop sharply.
 *  - Calibrated baselines tighten the STILL threshold so a pet's background
 *    motion doesn't keep us perpetually in "spike."
 *
 * UI labels this as [Inference] with a permanent disclaimer. Per CLAUDE.md
 * we DO NOT claim medical or safety guarantees.
 */
const INCIDENT_SPIKE = 6.0;             // motion above this is a clear event
const INCIDENT_STILL_UNCAL = 1.4;       // uncalibrated stillness threshold
const INCIDENT_STILL_CAL = 0.8;         // tighter once baseline is captured
const INCIDENT_SUSTAINED_S = 4.0;       // stillness must last this long after a spike
const INCIDENT_RESET_S = 8.0;           // suspected -> idle after this much normal motion

function deriveIncidentState(windows: DerivedWindow[]): IncidentReading {
  if (windows.length < 6) {
    return {
      state: "idle",
      detail: "Buffering — need a few seconds of motion data.",
      spikeMotion: null,
      recentMotion: null,
      stillSeconds: 0,
      windowsUsed: windows.length,
    };
  }

  // Use the last ~80 windows (≥10 s at 8 Hz, ≥4 s at 20 Hz).
  const tail = windows.slice(-Math.min(windows.length, 80));
  const calibrated = tail[tail.length - 1]?.baseline_calibrated ?? false;
  const stillThreshold = calibrated ? INCIDENT_STILL_CAL : INCIDENT_STILL_UNCAL;

  // Walk the buffer forward, advancing a small state machine. We don't
  // mutate React state — we just replay enough windows to stabilize on a
  // current state. The buffer length is bounded so this is O(N) per call.
  let state: IncidentState = "idle";
  let spikeMotion = 0;
  let stillSinceNs: number | null = null;
  let lastNs = tail[0].window_end_ns;
  for (const w of tail) {
    const motion = w.motion_score;
    const tNs = w.window_end_ns;
    const dt = Math.max(0, (tNs - lastNs) / 1e9);
    lastNs = tNs;

    if (motion >= INCIDENT_SPIKE) {
      // Any large motion resets to spike (and clears the still timer).
      state = "spike";
      spikeMotion = Math.max(spikeMotion, motion);
      stillSinceNs = null;
      continue;
    }

    if (state === "spike") {
      if (motion < stillThreshold) {
        // Just entered post-spike stillness.
        state = "post-spike-still";
        stillSinceNs = tNs;
      }
    } else if (state === "post-spike-still") {
      if (motion < stillThreshold) {
        const stillS = stillSinceNs == null ? 0 : (tNs - stillSinceNs) / 1e9;
        if (stillS >= INCIDENT_SUSTAINED_S) {
          state = "suspected";
        }
      } else {
        // Motion came back — drop back to plain "spike" tracking the new
        // value. If it stays low we'll re-enter post-spike-still.
        state = motion >= INCIDENT_SPIKE / 2 ? "spike" : "idle";
        stillSinceNs = null;
      }
    } else if (state === "suspected") {
      // Stay suspected until we either see another spike (→ spike) or the
      // motion has been "normal but not still" continuously for RESET_S.
      if (motion < stillThreshold) {
        // continued stillness — stay suspected, don't reset
      } else if (motion >= INCIDENT_SPIKE) {
        state = "spike";
        spikeMotion = motion;
        stillSinceNs = null;
      } else {
        // normal motion — start a "back to active" timer reusing stillSinceNs
        // as the "since-last-non-still" timestamp.
        if (stillSinceNs == null) stillSinceNs = tNs;
        const activeS = (tNs - stillSinceNs) / 1e9;
        if (activeS >= INCIDENT_RESET_S) {
          state = "idle";
          spikeMotion = 0;
          stillSinceNs = null;
        }
      }
    } else {
      // idle: track motion entering still vs active
      if (motion < stillThreshold) {
        // ambient stillness — nothing to do
      }
      // ignore dt to keep state simple
      void dt;
    }
  }

  const recentTail = tail.slice(-Math.max(1, Math.min(tail.length, 8)));
  const recentMotion =
    recentTail.reduce((acc, w) => acc + w.motion_score, 0) / recentTail.length;
  const stillSeconds =
    stillSinceNs == null
      ? 0
      : Math.max(0, (tail[tail.length - 1].window_end_ns - stillSinceNs) / 1e9);

  let detail: string;
  if (state === "suspected") {
    detail = `Sustained stillness (${stillSeconds.toFixed(1)} s) after a motion spike. Could be a fall — or someone simply sat down. Investigate.`;
  } else if (state === "post-spike-still") {
    detail = `Motion peaked and is settling. ${stillSeconds.toFixed(1)} s of stillness so far — needs ${INCIDENT_SUSTAINED_S.toFixed(1)} s before flagging.`;
  } else if (state === "spike") {
    detail = "Active motion in the link.";
  } else {
    detail =
      recentMotion < stillThreshold
        ? "Quiet — no significant motion in the link."
        : "Low-level motion — normal background.";
  }

  return {
    state,
    detail,
    spikeMotion: spikeMotion || null,
    recentMotion,
    stillSeconds,
    windowsUsed: tail.length,
  };
}

/* ---------- Latency budget (item 9.4) ---------- */

/*
 * End-to-end latency observability. We report what we can measure
 * truthfully from the host clock alone — TX/RX device clocks aren't
 * synced to the host so any "end-to-end" number that pretends to start
 * at TX is fiction. What we can show:
 *
 *  - Host → UI: now() minus the last window's window_end_ns (last raw
 *    frame in the latest derived window). This is the visible-data age.
 *  - Inter-window gap: the gap between consecutive windows' end times,
 *    averaged over the last 30 windows.
 *  - DSP cadence: derived windows per second (frontend-observed).
 *
 * The card refuses to display garbage if we don't have enough data.
 */
/* ---------- Demo presets (item 9.2) ---------- */

function DemoPresetCard() {
  const [presets, setPresets] = useState<DemoPreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await listPresets();
        if (!cancelled) setPresets(data.presets);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function play(preset: DemoPreset) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await startPreset(preset.id);
      // The shell's polling effect will pick up the new session within ~5 s.
      // Until then the user sees the existing UI; no state to reset here.
    } catch (err) {
      setError(err instanceof Error ? err.message : "preset start failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Demo replays">
      {error ? <div className="incidentWarn">{error}</div> : null}
      {presets.length === 0 ? (
        <small style={{ color: "var(--text-muted)" }}>
          No recordings yet. Each completed session writes a JSONL to{" "}
          <code>data/recordings/</code>; pick the file from that list and replay
          it deterministically for the demo.
        </small>
      ) : (
        <>
          <small style={{ color: "var(--text-muted)" }}>
            Click to stop the live source and replay a recorded session at 20 Hz.
            Useful when the hardware is finicky or the room conditions changed
            since the demo was rehearsed.
          </small>
          <div className="labelGrid" style={{ marginTop: 8, flexDirection: "column", gap: 6 }}>
            {presets.slice(0, 8).map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="secondaryButton"
                style={{ textAlign: "left", justifyContent: "flex-start" }}
                onClick={() => void play(preset)}
                disabled={busy}
                title={`${preset.estimated_frames.toLocaleString()} frames, ${(
                  preset.size_bytes / 1024 / 1024
                ).toFixed(1)} MB`}
              >
                ▶ {preset.label}
                <span style={{ marginLeft: 8, color: "var(--text-faint)", fontSize: 11 }}>
                  ~{preset.estimated_frames.toLocaleString()} frames
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function LatencyBudgetCard({ latest, windows }: { latest: DerivedWindow | null; windows: DerivedWindow[] }) {
  const now = Date.now();
  const visibleAgeMs = latest ? now - latest.window_end_ns / 1_000_000 : null;
  const tail = windows.slice(-30);
  let gapP50: number | null = null;
  let gapP95: number | null = null;
  let dspHz: number | null = null;
  if (tail.length >= 4) {
    const gaps: number[] = [];
    for (let i = 1; i < tail.length; i += 1) {
      gaps.push((tail[i].window_end_ns - tail[i - 1].window_end_ns) / 1_000_000);
    }
    gaps.sort((a, b) => a - b);
    gapP50 = gaps[Math.floor(gaps.length * 0.5)];
    gapP95 = gaps[Math.floor(gaps.length * 0.95)] ?? gaps[gaps.length - 1];
    const span = (tail[tail.length - 1].window_end_ns - tail[0].window_end_ns) / 1e9;
    if (span > 0) dspHz = (tail.length - 1) / span;
  }
  const tone =
    visibleAgeMs == null ? "muted"
    : visibleAgeMs < 300 ? "good"
    : visibleAgeMs < 1500 ? "warn"
    : "danger";
  return (
    <div className="card incidentCard" data-tone={tone}>
      <div className="incidentHead">
        <span className="incidentBadge">latency</span>
        <h3 className="incidentTitle">End-to-end budget</h3>
      </div>
      <div className={`incidentHeadline tone-${tone}`}>
        {visibleAgeMs == null ? "—" : `${visibleAgeMs.toFixed(0)} ms`}
        <span style={{ fontSize: 11, marginLeft: 8, color: "var(--text-faint)" }}>data age</span>
      </div>
      <div className="incidentMetrics">
        <div>
          <span>window p50 gap</span>
          <strong>{gapP50 != null ? `${gapP50.toFixed(0)} ms` : "—"}</strong>
        </div>
        <div>
          <span>window p95 gap</span>
          <strong>{gapP95 != null ? `${gapP95.toFixed(0)} ms` : "—"}</strong>
        </div>
        <div>
          <span>DSP rate</span>
          <strong>{dspHz != null ? `${dspHz.toFixed(1)} Hz` : "—"}</strong>
        </div>
      </div>
      <p className="incidentDisclaimer">
        Data age = wall-clock time since the last raw frame in the latest derived window. Inter-window gap
        captures DSP cadence variance. We can&apos;t report TX→RX device latency without clock sync — see
        link diagnostics for inter-arrival jitter.
      </p>
    </div>
  );
}

function IncidentCard({ incident, latest }: { incident: IncidentReading; latest: DerivedWindow | null }) {
  const tone =
    incident.state === "suspected" ? "danger"
    : incident.state === "post-spike-still" ? "warn"
    : incident.state === "spike" ? "info"
    : "muted";
  const headline =
    incident.state === "suspected" ? "INCIDENT SUSPECTED"
    : incident.state === "post-spike-still" ? "Settling after spike"
    : incident.state === "spike" ? "Active motion"
    : "All quiet";
  const calibrated = Boolean(latest?.baseline_calibrated);
  return (
    <div className="card incidentCard" data-tone={tone}>
      <div className="incidentHead">
        <span className="incidentBadge">[Inference]</span>
        <h3 className="incidentTitle">Fall / incident watch</h3>
      </div>
      <div className={`incidentHeadline tone-${tone}`}>{headline}</div>
      <p className="incidentDetail">{incident.detail}</p>
      <div className="incidentMetrics">
        <div>
          <span>spike motion</span>
          <strong>{incident.spikeMotion != null ? incident.spikeMotion.toFixed(1) : "—"}</strong>
        </div>
        <div>
          <span>recent motion</span>
          <strong>{incident.recentMotion != null ? incident.recentMotion.toFixed(1) : "—"}</strong>
        </div>
        <div>
          <span>still for</span>
          <strong>{incident.stillSeconds > 0 ? `${incident.stillSeconds.toFixed(1)}s` : "—"}</strong>
        </div>
      </div>
      {!calibrated ? (
        <p className="incidentWarn">Baseline not calibrated — thresholds use uncalibrated motion energy and will fire spuriously near walls or hardware drift. Capture baseline on the Diagnostics tab.</p>
      ) : null}
      <p className="incidentDisclaimer">
        Heuristic only. CSI motion can be a pet, an object, hardware drift, or a person — we cannot tell which. Do not use for safety decisions.
      </p>
    </div>
  );
}

/*
 * LiveControlBar — the single sticky strip at the top of the Live Room.
 *
 * The audit complaint was "I can't tell when it's connected or something is
 * happening, and I can't find how to start streaming". This bar answers both
 * in one row:
 *
 *   - 4 status pills (API / WS / Source / Stream) each green when healthy
 *     and red/grey/amber otherwise. Stream shows live Hz when frames flow.
 *   - one big primary action: Start (when no session) or Stop (when running).
 *   - any startError surfaces below the pills so a failed serial open is
 *     not silently swallowed.
 */
function LiveControlBar({
  apiReachable,
  connectionStatus,
  sourceMode,
  serialPort,
  hasSession,
  boardStreaming,
  framesEverReceived,
  latestWindowAgeSec,
  recentFramePerSec,
  starting,
  startError,
  onStart,
  onStop,
  onRefresh
}: {
  apiReachable: boolean;
  connectionStatus: string;
  sourceMode: SourceMode | null;
  serialPort: string | null;
  hasSession: boolean;
  boardStreaming: boolean;
  framesEverReceived: boolean;
  latestWindowAgeSec: number | null;
  recentFramePerSec: number | null;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  type Tone = "good" | "warn" | "danger" | "muted" | "info";
  const apiTone: Tone = apiReachable ? "good" : "danger";
  const apiLabel = apiReachable ? "ONLINE" : "OFFLINE";
  const wsTone: Tone =
    connectionStatus === "connected" ? "good"
    : connectionStatus === "connecting" ? "info"
    : "danger";
  const wsLabel = connectionStatus.toUpperCase();
  const sourceConfigured = sourceMode === "REPLAY" || Boolean(serialPort);
  const sourceTone: Tone = sourceConfigured ? "good" : "warn";
  const sourceLabel = sourceMode === "REPLAY"
    ? "REPLAY"
    : serialPort
    ? serialPort.toUpperCase()
    : "PORT UNSET";
  const streamTone: Tone = boardStreaming
    ? "good"
    : framesEverReceived
    ? "warn"
    : hasSession
    ? "info"
    : "muted";
  const streamLabel = boardStreaming && recentFramePerSec != null
    ? `${recentFramePerSec.toFixed(1)} Hz`
    : framesEverReceived && latestWindowAgeSec != null
    ? `STALLED ${latestWindowAgeSec.toFixed(0)}s`
    : hasSession
    ? "WAITING"
    : "NOT STARTED";
  const startDisabled = starting || !apiReachable || (sourceMode === "LIVE" && !serialPort);
  return (
    <section className="liveControlBar" aria-label="Stream control">
      <div className="liveControlPills">
        <Pill label="API" tone={apiTone} value={apiLabel} />
        <Pill label="WS" tone={wsTone} value={wsLabel} />
        <Pill label="SOURCE" tone={sourceTone} value={sourceLabel} />
        <Pill label="STREAM" tone={streamTone} value={streamLabel} />
      </div>
      <div className="liveControlActions">
        <button
          type="button"
          className="iconButton"
          onClick={onRefresh}
          aria-label="Refresh runtime state"
        >
          <RefreshCw size={14} />
        </button>
        {hasSession ? (
          <button
            type="button"
            onClick={onStop}
            style={{
              minWidth: 180,
              padding: "10px 22px",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: "transparent",
              color: "#ff5e5e",
              border: "1px solid #ff5e5e",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
            }}
          >
            <Square size={14} /> STOP STREAMING
          </button>
        ) : (
          // Hard-coded inline styles so the button is visible even if a stale
          // Turbopack chunk drops the .liveControlPrimary class — the audit
          // feedback was "I do not see a Start button anywhere", so we
          // refuse to depend on a CSS class that might not have shipped yet.
          <button
            type="button"
            onClick={onStart}
            disabled={startDisabled}
            style={{
              minWidth: 200,
              padding: "10px 22px",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: startDisabled ? "#333" : "#1f7a3a",
              color: startDisabled ? "#888" : "#ffffff",
              border: `1px solid ${startDisabled ? "#444" : "#25923f"}`,
              cursor: startDisabled ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
            }}
            title={
              !apiReachable
                ? "API is offline — start uvicorn first"
                : sourceMode === "LIVE" && !serialPort
                ? "Set AETHER_SERIAL_PORT and restart the API"
                : "Open the serial port and begin streaming"
            }
          >
            {starting ? "STARTING…" : "▶ START STREAMING"}
          </button>
        )}
      </div>
      {startError ? (
        <div className="liveControlError" role="alert">
          {startError}
        </div>
      ) : null}
    </section>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "danger" | "muted" | "info" }) {
  return (
    <div className={`statusPill tone-${tone}`}>
      <span className="statusPillLabel">{label}</span>
      <span className="statusPillValue">{value}</span>
    </div>
  );
}

/*
 * ReadinessChecklist - the single answer to "why don't I see anything?".
 *
 * Five sequential gates; each has a tone of success / warning / danger /
 * muted and a one-line "what to do". An operator should be able to look at
 * this and within ~3 s know which step is blocking them. The gates intentionally
 * mirror the order in which they need to pass:
 *
 *   1. API reachable      -> must be true before anything else can be checked
 *   2. WebSocket connected
 *   3. Source configured  -> serial port set (LIVE) or replay path (REPLAY)
 *   4. Session started
 *   5. CSI frames flowing -> latest window arrived in the last 3 seconds
 *   6. Baseline calibrated (optional but recommended)
 *
 * Once all green, the disconnected banner above also clears.
 */
function ReadinessChecklist({
  apiReachable,
  connectionStatus,
  sourceMode,
  serialPort,
  hasSession,
  boardStreaming,
  framesEverReceived,
  calibrated
}: {
  apiReachable: boolean;
  connectionStatus: string;
  sourceMode: SourceMode | null;
  serialPort: string | null;
  hasSession: boolean;
  boardStreaming: boolean;
  framesEverReceived: boolean;
  calibrated: boolean;
}) {
  type Tone = "success" | "warning" | "danger" | "muted";
  // apiOk reads HTTP, NOT the WebSocket. The two failure modes are
  // independent: the API can be perfectly healthy while the WS is down
  // (typical: dev hot-reload tore the socket but uvicorn still answers
  // /health). Conflating them used to mislead the operator into
  // restarting uvicorn when the real fix was clearing .next.
  const apiOk = apiReachable;
  const wsOk = connectionStatus === "connected";
  const sourceOk = sourceMode === "REPLAY" ? true : Boolean(serialPort);
  const items: { label: string; tone: Tone; hint: string }[] = [
    {
      label: "API reachable",
      tone: apiOk ? "success" : "danger",
      hint: apiOk
        ? "Host service is responding."
        : "Start uvicorn: python -m uvicorn apps.api.src.main:app --reload"
    },
    {
      label: "WebSocket /ws/live connected",
      tone: wsOk ? "success" : connectionStatus === "connecting" ? "warning" : "danger",
      hint: wsOk
        ? "Live stream socket is open."
        : connectionStatus === "connecting"
        ? "Browser is still trying to reach /ws/live."
        : apiOk
        ? "Socket dropped while HTTP is fine - usually a Turbopack ChunkLoadError. Stop next dev, delete apps/web/.next, restart."
        : "Socket closed. Fix the API first, then the WS will follow."
    },
    {
      label: sourceMode === "REPLAY" ? "Replay file configured" : "Serial port configured",
      tone: sourceOk ? "success" : "warning",
      hint: sourceOk
        ? sourceMode === "REPLAY"
          ? "AETHER_REPLAY_PATH is set."
          : `RX board on ${serialPort}.`
        : sourceMode === "REPLAY"
        ? "Set AETHER_REPLAY_PATH to a recorded .jsonl file and restart the API."
        : "Set AETHER_SERIAL_PORT (e.g. COM5) and restart the API."
    },
    {
      label: "Session started",
      tone: hasSession ? "success" : "muted",
      hint: hasSession
        ? "Backend collector + DSP are running for this session."
        : "Click Start session below or on the Experiment Console page."
    },
    {
      label: "CSI frames flowing",
      tone: boardStreaming ? "success" : framesEverReceived ? "warning" : "muted",
      hint: boardStreaming
        ? "Derived window arrived in the last 3 s."
        : framesEverReceived
        ? "Stream stalled. Check serial cable and that the RX firmware is still emitting CSI."
        : "Waiting for first window. The DSP needs ~10 frames buffered before it emits one."
    },
    {
      label: "Baseline calibrated",
      tone: calibrated ? "success" : "muted",
      hint: calibrated
        ? "Empty-room subtraction is active."
        : "Hold the room empty and run a 10 s calibration to make occupancy meaningful."
    }
  ];
  return (
    <section className="card">
      <div className="cardHeader">
        <h2>Readiness</h2>
      </div>
      <ul className="readinessList">
        {items.map((item) => (
          <li key={item.label} className={`readinessItem readiness-${item.tone}`}>
            <StatusDot status={item.tone} />
            <div className="readinessCopy">
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeviceStatusCard({
  latest,
  serialPort,
  boardStreaming,
  framesEverReceived,
  latestWindowAgeSec,
  recentFramePerSec
}: {
  latest: DerivedWindow | null;
  serialPort: string | null;
  boardStreaming: boolean;
  framesEverReceived: boolean;
  latestWindowAgeSec: number | null;
  recentFramePerSec: number | null;
}) {
  // RX state distinguishes 4 honest cases:
  //   not configured  -> serial port env var unset
  //   no frames yet   -> port set but DSP never produced a window
  //   stalled         -> we had frames but none in the last 3 seconds
  //   streaming       -> windows arriving right now
  const rxState = !serialPort
    ? "not configured"
    : !framesEverReceived
    ? "no frames yet"
    : !boardStreaming
    ? `stalled (${latestWindowAgeSec?.toFixed(0) ?? "?"} s)`
    : "streaming";
  const rxDetail = !serialPort
    ? "Set AETHER_SERIAL_PORT and restart the API"
    : latest
    ? `${latest.mean_rssi_dbm.toFixed(1)} dBm @ ${(recentFramePerSec ?? latest.packet_rate_hz).toFixed(1)} Hz`
    : `Port ${serialPort} configured, waiting for first CSI window`;
  return (
    <Card title="Device Status">
      <DeviceRow name="TX board" state="unknown" detail="No firmware health endpoint exposed" />
      <DeviceRow name="RX board" state={rxState} detail={rxDetail} />
    </Card>
  );
}

function DeviceRow({ name, state, detail }: { name: string; state: string; detail: string }) {
  // Map honest device-state strings to a tone. The new states are:
  //   "streaming"      -> success (data flowing right now)
  //   "no frames yet"  -> muted   (configured, waiting for first window)
  //   "stalled (Ns)"   -> warning (had data, then went quiet)
  //   "not configured" -> danger  (cannot work until env var is set)
  //   "unknown"        -> warning (TX board, no health endpoint)
  //   anything else    -> danger
  const tone = state === "streaming"
    ? "success"
    : state === "no frames yet"
    ? "muted"
    : state.startsWith("stalled") || state === "unknown"
    ? "warning"
    : "danger";
  return (
    <div className="dataRow">
      <div>
        <strong>{name}</strong>
        <span>{detail}</span>
      </div>
      <span className="stateLabel">
        <StatusDot status={tone} />
        {state}
      </span>
    </div>
  );
}

function SessionCard({ latest }: { latest: DerivedWindow | null }) {
  return (
    <Card title="Session">
      {latest ? (
        <div className="kvList">
          <div><span>Session</span><code>{latest.session_id}</code></div>
          <div><span>Packet count</span><code>{latest.packet_count}</code></div>
          <div><span>Source</span><SourceBadge mode={latest.source_mode} /></div>
        </div>
      ) : (
        <EmptyState title="No active stream" message="Start a live or replay session to populate session telemetry." />
      )}
    </Card>
  );
}

function SignalQualityCard({ latest }: { latest: DerivedWindow | null }) {
  const quality = latest?.quality_score ?? 0;
  const loss = latest?.packet_loss_ratio;
  const fwi = latest?.first_word_invalid_ratio;
  const jitter = latest?.jitter_ms;
  const expected = latest?.expected_packet_rate_hz;
  const rate = latest?.packet_rate_hz;
  const fmtPct = (v: number | null | undefined) => (v == null ? "--" : `${(v * 100).toFixed(1)}%`);
  const fmtMs = (v: number | null | undefined) => (v == null ? "--" : `${v.toFixed(1)} ms`);
  const fmtHz = (v: number | null | undefined) => (v == null ? "--" : `${v.toFixed(1)} Hz`);
  return (
    <Card title="Signal Quality">
      <div className="meter" aria-label="Signal quality score">
        <span style={{ width: `${quality * 100}%` }} />
      </div>
      <div className="kvList">
        <div><span>Quality</span><code>{latest ? `${Math.round(quality * 100)}%` : "--"}</code></div>
        <div>
          <span>Packet rate</span>
          <code>
            {fmtHz(rate)} {expected ? `(target ${fmtHz(expected)})` : ""}
          </code>
        </div>
        <div><span>Packet loss</span><code>{fmtPct(loss)}</code></div>
        <div><span>Invalid frames</span><code>{fmtPct(fwi)}</code></div>
        <div><span>Jitter</span><code>{fmtMs(jitter)}</code></div>
        <div><span>RSSI</span><code>{latest ? `${latest.mean_rssi_dbm.toFixed(1)} dBm` : "--"}</code></div>
      </div>
    </Card>
  );
}

function CalibrationCard({
  latest,
  calibration,
  busy,
  onCalibrate,
  onReset,
  onCancel
}: {
  latest: DerivedWindow | null;
  calibration: CalibrationStatus | null;
  busy: boolean;
  onCalibrate: (seconds: number) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const calibrated = Boolean(calibration?.is_calibrated || latest?.baseline_calibrated);
  const calibrating = Boolean(calibration?.is_calibrating);
  const progress = calibration?.progress ?? 0;
  const frames = calibration?.frames_observed ?? 0;
  const subcarriers = calibration?.subcarrier_count ?? latest?.subcarrier_count ?? 0;
  const target = calibration?.target_seconds ?? 10;
  const stateLabel = calibrating
    ? "calibrating"
    : calibrated
    ? "calibrated"
    : "uncalibrated";
  const tone = calibrating ? "warning" : calibrated ? "success" : "muted";
  const ready = Boolean(latest);

  return (
    <Card title="Baseline Calibration">
      <div className="dataRow">
        <div>
          <strong>Empty-room baseline</strong>
          <span>
            Subtract the empty-room signal to make motion / occupancy meaningful.
            Hold the room empty during calibration.
          </span>
        </div>
        <span className="stateLabel">
          <StatusDot status={tone as "success" | "warning" | "muted"} />
          {stateLabel}
        </span>
      </div>
      <div className="meter" aria-label="Calibration progress">
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="kvList">
        <div><span>Progress</span><code>{Math.round(progress * 100)}%</code></div>
        <div><span>Frames captured</span><code>{frames}</code></div>
        <div><span>Subcarriers</span><code>{subcarriers}</code></div>
        <div><span>Target window</span><code>{target.toFixed(1)} s</code></div>
      </div>
      <div className="labelGrid" style={{ marginTop: 8 }}>
        {calibrating ? (
          <button className="dangerButton" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : (
          <>
            <button
              className="primaryButton"
              type="button"
              onClick={() => onCalibrate(10)}
              disabled={busy || !ready}
              title={ready ? "Capture 10 s of empty-room CSI" : "Live frames required"}
            >
              Calibrate (10 s)
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => onCalibrate(20)}
              disabled={busy || !ready}
            >
              Calibrate (20 s)
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={onReset}
              disabled={busy || !calibrated}
            >
              Reset
            </button>
          </>
        )}
      </div>
      {calibration?.drift_detected ? (
        <div className="incidentWarn" style={{ marginTop: 8 }}>
          Drift detected — the still-frame amplitude has moved {(((calibration?.drift_score ?? 0) * 100)).toFixed(0)}% from the captured baseline ({calibration?.drift_samples ?? 0} still-frame samples). Recalibrate to restore reliable motion / occupancy thresholds.
        </div>
      ) : calibrated && (calibration?.drift_samples ?? 0) > 0 ? (
        <small style={{ color: "var(--text-muted)" }}>
          Drift score {(((calibration?.drift_score ?? 0) * 100)).toFixed(1)}% over {calibration?.drift_samples ?? 0} still-frame samples (warn at 18%).
        </small>
      ) : null}
      <small style={{ color: "var(--text-muted)" }}>
        Without a baseline, occupancy reads &quot;uncalibrated&quot; even if motion is detected.
      </small>
    </Card>
  );
}

function RoomSummaryCard({ summary }: { summary: RoomSummary | null }) {
  return (
    <Card title="Room Summary" sourceMode={summary?.source_mode ?? null}>
      {summary ? (
        <div className="summaryBullets">
          <div><ConfidenceBadge level={confidenceFrom(summary.confidence)} /></div>
          <p>Occupancy: {summary.occupancy ?? "unknown"}</p>
          <p>Motion: {summary.motion ?? "unknown"}</p>
          <p>Confidence: {Math.round((summary.confidence ?? 0) * 100)}%</p>
          <small>Timestamp: {summary.timestamp_ns ?? "unavailable"}</small>
        </div>
      ) : (
        <EmptyState title="No summary" message="Structured summaries appear after derived windows arrive." />
      )}
    </Card>
  );
}

interface VitalSummary {
  respDisplay: string | null;
  respDetail: string;
  respConfidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  hrDisplay: string | null;
  hrDetail: string;
  hrConfidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  stillnessGated: boolean;
  signalPath: string | null;
  looksLikeHarmonic: boolean;
}

function deriveVitalSummary(latest: DerivedWindow | null): VitalSummary {
  if (!latest) {
    return {
      respDisplay: null,
      respDetail: "Waiting for CSI stream",
      respConfidence: "UNKNOWN",
      hrDisplay: null,
      hrDetail: "Waiting for CSI stream",
      hrConfidence: "UNKNOWN",
      stillnessGated: false,
      signalPath: null,
      looksLikeHarmonic: false
    };
  }
  const gated = Boolean(latest.stillness_gated);
  // Respiration display rules: must have a tracker number (smoothed),
  // confidence >= 0.30, FFT/ACF agreement implied by tracker existing,
  // and stillness gate not active.
  const respConf = latest.respiration_confidence ?? 0;
  const respTracked = latest.respiration_tracked_bpm ?? null;
  const respDisplay =
    !gated && respTracked != null && respConf >= 0.3 ? respTracked.toFixed(1) : null;
  const respDetail = gated
    ? "Movement detected — vital readings suppressed"
    : respDisplay
    ? `FFT peak in 0.10–0.50 Hz, cross-checked against autocorrelation. Tracked ${respTracked!.toFixed(
        1
      )} bpm.`
    : "No periodic signal of sufficient confidence in the breathing band.";

  const hrConf = latest.heart_rate_proxy_confidence ?? 0;
  const hrTracked = latest.heart_rate_proxy_tracked_bpm ?? null;
  const looksHarmonic = Boolean(latest.looks_like_respiration_harmonic);
  const hrDisplay =
    !gated && !looksHarmonic && hrTracked != null && hrConf >= 0.45
      ? hrTracked.toFixed(0)
      : null;
  const hrDetail = gated
    ? "Movement detected — vital readings suppressed"
    : looksHarmonic
    ? "Peak in HR band looks like the 2nd harmonic of respiration. Suppressed."
    : hrDisplay
    ? "Strongest periodic motion in 0.80–2.50 Hz. NOT validated against ECG."
    : "No coherent periodic motion in the HR band, or FFT/ACF disagree.";

  return {
    respDisplay,
    respDetail,
    respConfidence: confidenceFrom(respConf),
    hrDisplay,
    hrDetail,
    hrConfidence: confidenceFrom(hrConf),
    stillnessGated: gated,
    signalPath: latest.biorhythm_signal_path ?? null,
    looksLikeHarmonic: looksHarmonic
  };
}

function RespirationCard({
  latest,
  windows,
  vital
}: {
  latest: DerivedWindow | null;
  windows: DerivedWindow[];
  vital: VitalSummary;
}) {
  const trend = windows
    .map((w) => w.respiration_tracked_bpm ?? w.respiration_bpm ?? null)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const fft = latest?.respiration_bpm ?? null;
  const acf = latest?.respiration_bpm_acf ?? null;
  const harm = latest?.respiration_harmonic_prominence ?? null;
  return (
    <Card title="Respiration (research)" sourceMode={latest?.source_mode ?? null} researchOnly>
      {vital.stillnessGated ? (
        <div className="gateBanner">Movement detected — respiration reading suppressed.</div>
      ) : null}
      <MetricCard
        title=""
        value={vital.respDisplay}
        unit={vital.respDisplay ? "bpm" : undefined}
        confidence={vital.respConfidence}
        detail={vital.respDetail}
        sparkline={trend}
        icon={<Waves size={14} />}
      />
      <div className="kvList">
        <div><span>FFT peak</span><code>{fft != null ? `${fft.toFixed(1)} bpm` : "--"}</code></div>
        <div><span>ACF peak</span><code>{acf != null ? `${acf.toFixed(1)} bpm` : "--"}</code></div>
        <div>
          <span>Harmonic prominence</span>
          <code>{harm != null ? harm.toFixed(2) : "--"}</code>
        </div>
        <div><span>Signal path</span><code>{vital.signalPath ?? "--"}</code></div>
      </div>
      <small style={{ color: "var(--text-muted)" }}>
        Displayed value is the confidence-tracked BPM. Raw FFT and ACF estimates are shown so you can sanity-check
        agreement; large disagreement means the peak is unreliable.
      </small>
    </Card>
  );
}

function HeartBandCard({
  latest,
  windows,
  vital
}: {
  latest: DerivedWindow | null;
  windows: DerivedWindow[];
  vital: VitalSummary;
}) {
  const trend = windows
    .map((w) => w.heart_rate_proxy_tracked_bpm ?? w.heart_rate_proxy_bpm ?? null)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const fft = latest?.heart_rate_proxy_bpm ?? null;
  const acf = latest?.heart_rate_proxy_bpm_acf ?? null;
  return (
    <Card title="Motion-band peak (0.8–2.5 Hz)" sourceMode={latest?.source_mode ?? null} researchOnly>
      {vital.stillnessGated ? (
        <div className="gateBanner">Movement detected — motion-band peak suppressed.</div>
      ) : null}
      {vital.looksLikeHarmonic ? (
        <div className="harmonicBanner">
          Peak frequency is ~2× the respiration peak — almost certainly a respiration harmonic.
        </div>
      ) : null}
      <MetricCard
        title=""
        value={vital.hrDisplay}
        unit={vital.hrDisplay ? "bpm" : undefined}
        confidence={vital.hrConfidence}
        detail={vital.hrDetail}
        sparkline={trend}
      />
      <div className="kvList">
        <div><span>FFT peak</span><code>{fft != null ? `${fft.toFixed(0)} bpm` : "--"}</code></div>
        <div><span>ACF peak</span><code>{acf != null ? `${acf.toFixed(0)} bpm` : "--"}</code></div>
      </div>
      <small style={{ color: "var(--text-muted)" }}>
        This is the strongest periodicity in 0.80–2.50 Hz, not a clinical heart rate. On ESP32 PCB antennas at
        2 m, real cardiac micro-motion is below the noise floor; what you see here is far more often respiration
        harmonics, fidgeting, or interference. We display a number only when stillness, FFT/ACF agreement, and
        harmonic checks all pass.
      </small>
    </Card>
  );
}

/*
 * Walking gait / cadence card. Shows the spectral peak frequency in
 * the 1.5–3 Hz band (typical adult walking step rate) plus the band
 * energy ratio. Sustained peaks here = walking through the link.
 *
 * Labelled [Inference] — CSI sees motion, not feet. A dog running back
 * and forth or a fan spinning at 2 Hz would also light this up.
 */
function GaitCard({ latest, windows }: { latest: DerivedWindow | null; windows: DerivedWindow[] }) {
  const stepsPerMin = latest?.gait_steps_per_min ?? null;
  const score = latest?.gait_score ?? null;
  const trend = windows
    .map((w) => w.gait_steps_per_min ?? null)
    .filter((v): v is number => v != null && Number.isFinite(v));
  // Heuristic: only display a number if energy ratio is meaningful AND
  // we have a peak. This avoids printing 100 spm when the whole spectrum
  // is at the noise floor.
  const stable = score != null && score > 0.06 && stepsPerMin != null;
  return (
    <Card title="Walking cadence (1.5–3 Hz)" sourceMode={latest?.source_mode ?? null} researchOnly>
      <MetricCard
        title=""
        value={stable ? Math.round(stepsPerMin).toString() : null}
        unit={stable ? "steps/min" : undefined}
        confidence={confidenceFrom(score)}
        detail={
          stable
            ? "Sustained peak in walking-cadence band. [Inference] — CSI sees motion, not feet."
            : "No walking-cadence peak above the noise floor in this window."
        }
        sparkline={trend}
      />
      <small style={{ color: "var(--text-muted)" }}>
        Band energy ratio: {score != null ? `${(score * 100).toFixed(0)}%` : "--"}. Walking through the link
        typically holds &gt;15% energy in 1.5–3 Hz with a stable peak; standing still keeps this near zero.
      </small>
    </Card>
  );
}

function FidgetEnergyCard({
  latest,
  windows
}: {
  latest: DerivedWindow | null;
  windows: DerivedWindow[];
}) {
  const value = latest?.fidget_score == null ? null : `${(latest.fidget_score * 100).toFixed(0)}%`;
  const trend = windows
    .map((w) => w.fidget_score ?? null)
    .filter((v): v is number => v != null && Number.isFinite(v));
  return (
    <MetricCard
      title="Fidget energy"
      value={value}
      detail="Spectral energy ratio in 2.5–8 Hz, from the conditioned CSI series."
      confidence={confidenceFrom(latest?.quality_score)}
      sparkline={trend}
    />
  );
}

function Devices({
  devices,
  sourceMode,
  connectionStatus,
  boardStreaming,
  framesEverReceived,
  latestWindowAgeSec,
  recentFramePerSec
}: {
  devices: Record<string, unknown> | null;
  sourceMode: SourceMode | null;
  connectionStatus: string;
  boardStreaming: boolean;
  framesEverReceived: boolean;
  latestWindowAgeSec: number | null;
  recentFramePerSec: number | null;
}) {
  const tx = (devices?.tx ?? {}) as Record<string, unknown>;
  const rx = (devices?.rx ?? {}) as Record<string, unknown>;
  const serialPort = typeof rx.serial_port === "string" && rx.serial_port.length > 0 ? rx.serial_port : null;
  const rxStatus = String(rx.status ?? "unknown");
  // RX state: "not configured" / "no frames yet" / "stalled (Ns)" / "streaming"
  // The previous build mapped WS-connected to RX-connected, which lied when
  // the WebSocket was up but the serial port was unset (your case today).
  const rxStateLabel = !serialPort
    ? "not configured"
    : !framesEverReceived
    ? "no frames yet"
    : !boardStreaming
    ? `stalled (${latestWindowAgeSec?.toFixed(0) ?? "?"} s)`
    : "streaming";
  return (
    <section className="settingsGrid">
      <Card title="TX Board">
        <DeviceRow name="Status" state={String(tx.status ?? "unknown")} detail={String(tx.role ?? "esp32-s3-tx")} />
        <DeviceRow name="Firmware" state="unknown" detail="No firmware health endpoint exposed yet" />
      </Card>
      <Card title="RX Board">
        <DeviceRow
          name="Status"
          state={rxStateLabel}
          detail={String(rx.role ?? "esp32-s3-rx")}
        />
        <div className="kvList">
          <div><span>Serial port</span><code>{serialPort ?? "not configured"}</code></div>
          <div><span>Baud</span><code>{String(rx.baud ?? "unknown")}</code></div>
          <div><span>Backend status</span><code>{rxStatus}</code></div>
          <div><span>Source</span><SourceBadge mode={sourceMode} /></div>
          <div>
            <span>Live rate</span>
            <code>{recentFramePerSec != null ? `${recentFramePerSec.toFixed(1)} Hz` : "--"}</code>
          </div>
          <div>
            <span>Last window</span>
            <code>{latestWindowAgeSec != null ? `${latestWindowAgeSec.toFixed(1)} s ago` : "--"}</code>
          </div>
        </div>
      </Card>
      <Card title="Host Services">
        <div className="dataTableCompact">
          <div><span>API</span><StatusDot status="success" /></div>
          <div><span>WebSocket</span><StatusDot status={connectionStatus === "connected" ? "success" : "danger"} /></div>
          <div><span>Collector (frames flowing)</span><StatusDot status={boardStreaming ? "success" : "muted"} /></div>
          <div><span>DSP (windows flowing)</span><StatusDot status={boardStreaming ? "success" : "muted"} /></div>
          <div><span>KB</span><StatusDot status="muted" /></div>
        </div>
      </Card>
      <Card title="Serial Configuration">
        {serialPort ? (
          <div className="kvList">
            <div><span>Configured port</span><code>{serialPort}</code></div>
            <div><span>Configured baud</span><code>{String(rx.baud ?? 115200)}</code></div>
            <div><span>Override</span><code>AETHER_SERIAL_PORT in .env</code></div>
          </div>
        ) : (
          <EmptyState
            title="Serial port not configured"
            message="Set AETHER_SERIAL_PORT (e.g. COM5 on Windows, /dev/ttyUSB0 on Linux) in your shell or .env, then restart the API."
          />
        )}
      </Card>
      <Card title="Calibration Checklist">
        <ol className="checklist">
          <li>Connect TX and RX boards.</li>
          <li>Flash ESP-IDF firmware.</li>
          <li>Set <code>AETHER_SERIAL_PORT</code> and restart the API.</li>
          <li>Click <strong>Start Session</strong> on the Live Room page.</li>
          <li>With the room empty, click <strong>Calibrate</strong> in the Baseline Calibration card.</li>
        </ol>
      </Card>
    </section>
  );
}

function ExperimentConsole({
  activeSession,
  latest,
  onCreated,
  onRefresh
}: {
  activeSession: SessionRecord | null;
  latest: DerivedWindow | null;
  onCreated: (session: SessionRecord) => void;
  onRefresh: () => void;
}) {
  const [protocol, setProtocol] = useState(protocolDefinitions[0].id);
  const [sessionName, setSessionName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = protocolDefinitions.find((item) => item.id === protocol) ?? protocolDefinitions[0];
  const labels = ["person_entered", "person_exited", "cross_los", "sit_still", "wave_hand", "breathing_trial"];

  async function createAndStart() {
    let session: SessionRecord | null = null;
    try {
      session = await createSession({ protocol, notes: `${sessionName}\n${notes}`.trim() });
      onCreated(session);
      const started = await startSession(session.session_id);
      onCreated(started);
      onRefresh();
      setError(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to create session";
      setError(session ? `Session created, but stream did not start: ${message}` : message);
    }
  }

  async function writeLabel(eventType: string) {
    if (!activeSession) return;
    try {
      await addSessionEvent(activeSession.session_id, eventType);
      onRefresh();
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to write label");
    }
  }

  return (
    <section className="experimentGrid">
      <Card title="Session Configuration">
        <label className="fieldLabel">Session name</label>
        <input className="input" value={sessionName} onChange={(event) => setSessionName(event.target.value)} />
        <label className="fieldLabel">Protocol</label>
        <select className="input" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
          {protocolDefinitions.map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        <label className="fieldLabel">Packet rate override</label>
        <input className="input" min="1" type="number" disabled aria-label="Packet rate override unavailable" />
        <label className="fieldLabel">Notes</label>
        <textarea className="input notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        {error ? <p className="formError">{error}</p> : null}
        <button className="primaryButton" onClick={createAndStart} type="button">Create Session</button>
      </Card>
      <Card title="Active Session">
        {activeSession ? (
          <>
            <div className="kvList">
              <div><span>Protocol</span><code>{activeSession.protocol}</code></div>
              <div><span>Session</span><code>{activeSession.session_id}</code></div>
            </div>
            <SectionHeader title="Protocol steps" />
            <ol className="checklist">
              <li><StatusDot status="success" /> Session created</li>
              <li><StatusDot status={latest ? "success" : "warning"} /> Stream observed</li>
              <li><StatusDot status="muted" /> Labels written</li>
            </ol>
            <SectionHeader title="Labels" />
            <div className="labelGrid">
              {labels.map((label) => (
                <button className="secondaryButton" key={label} onClick={() => void writeLabel(label)} type="button">
                  <EventTag eventType={label} />
                </button>
              ))}
            </div>
          </>
        ) : (
          <EmptyState title="No active session" message="Create a session to enable labels and protocol tracking." />
        )}
      </Card>
      <Card title="Live Metrics">
        <MetricCard title="Motion" value={latest ? latest.motion_score.toFixed(2) : null} sparkline={latest ? [latest.motion_score] : []} />
        <MetricCard title="Occupancy" value={latest ? latest.occupancy_score.toFixed(2) : null} sparkline={latest ? [latest.occupancy_score] : []} />
      </Card>
      <Card title="Protocol Reference">
        <h2>{selected.title}</h2>
        <p>{selected.purpose}</p>
        <SectionHeader title="Success criteria" />
        <p>{selected.success}</p>
      </Card>
    </section>
  );
}

function DataExplorer({ sessions, latest }: { sessions: SessionRecord[]; latest: DerivedWindow | null }) {
  const [selectedSession, setSelectedSession] = useState(sessions[0]?.session_id ?? "");
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState("Raw Frames");

  useEffect(() => {
    if (!selectedSession && sessions.length) {
      setSelectedSession(sessions[0].session_id);
    }
  }, [selectedSession, sessions]);

  useEffect(() => {
    if (!selectedSession) {
      setSummary(null);
      return;
    }
    void getSessionSummary(selectedSession).then(setSummary).catch(() => setSummary(null));
  }, [selectedSession]);

  const derivedRows = latest ? [latest] : [];
  const columns = useMemo<ColumnDef<DerivedWindow>[]>(
    () => [
      { header: "Timestamp", accessorFn: (row) => row.window_end_ns },
      { header: "Motion", accessorFn: (row) => row.motion_score.toFixed(2) },
      { header: "Occupancy", accessorFn: (row) => row.occupancy_score.toFixed(2) },
      { header: "Anomaly", accessorFn: (row) => row.anomaly_score.toFixed(2) },
      { header: "Respiration", accessorFn: (row) => row.respiration_bpm ?? "null" }
    ],
    []
  );

  return (
    <section className="pageStack">
      <Card title="Filters">
        <div className="filterBar">
          <select className="input" value={selectedSession} onChange={(event) => setSelectedSession(event.target.value)}>
            <option value="">Select session</option>
            {sessions.map((session) => (
              <option key={session.session_id} value={session.session_id}>{session.protocol} / {session.session_id}</option>
            ))}
          </select>
          <input className="input" type="date" aria-label="Date range start" />
          <select className="input" aria-label="Event filter"><option>All events</option></select>
          <button className="primaryButton" disabled={!selectedSession} type="button">Export</button>
        </div>
      </Card>
      <div className="tabBar">
        {["Raw Frames", "Derived Windows", "Events", "Report"].map((item) => (
          <button className={tab === item ? "tabButton active" : "tabButton"} key={item} onClick={() => setTab(item)} type="button">{item}</button>
        ))}
      </div>
      <Card title={tab}>
        {tab === "Derived Windows" ? (
          <DataTable columns={columns} data={derivedRows} emptyTitle="No derived windows" emptyMessage="Start a live or replay stream to inspect derived windows." />
        ) : null}
        {tab === "Report" ? (
          summary ? <pre>{JSON.stringify(summary, null, 2)}</pre> : <EmptyState title="No report" message="Select a stored session to load its summary." />
        ) : null}
        {tab === "Raw Frames" ? <EmptyState title="Raw frame table unavailable" message="The current API exposes summaries, not paginated raw frame rows." /> : null}
        {tab === "Events" ? <EmptyState title="Event stream unavailable" message="The current API writes events but does not expose an event-list endpoint." /> : null}
      </Card>
    </section>
  );
}

function KnowledgeBase() {
  return (
    <section className="knowledgeGrid">
      <Card title="Filters">
        <EmptyState title="KB API unavailable" message="Document facets require a search endpoint that is not exposed in the current API scope." />
      </Card>
      <Card title="Documents">
        <EmptyState title="No searchable documents" message="Knowledge Base search is disabled until a real endpoint is available." />
      </Card>
    </section>
  );
}

function AgentConsole({ sourceMode, activeSession }: { sourceMode: SourceMode | null; activeSession: SessionRecord | null }) {
  return (
    <section className="agentGrid">
      <Card title="Message Thread">
        <EmptyState title="Agent unavailable" message="No existing API endpoint exposes grounded agent tool output. No canned responses are shown." />
      </Card>
      <Card title="Tool Status">
        <div className="dataTableCompact">
          {["get_live_room_summary", "get_recent_derived_windows", "get_session_summary", "search_knowledge_base", "compare_sessions"].map((tool) => (
            <div key={tool}><span>{tool}</span><StatusDot status="muted" /></div>
          ))}
        </div>
        <SectionHeader title="Active context" />
        <div className="kvList">
          <div><span>Session</span><code>{activeSession?.session_id ?? "none"}</code></div>
          <div><span>Source</span><SourceBadge mode={sourceMode} /></div>
        </div>
      </Card>
    </section>
  );
}

function SettingsPage() {
  return (
    <section className="settingsGrid">
      <Card title="Runtime Configuration">
        <div className="kvList">
          <div><span>API</span><code>http://127.0.0.1:8000</code></div>
          <div><span>WebSocket</span><code>/ws/live</code></div>
          <div><span>Default mode</span><code>LIVE unless AETHER_REPLAY_PATH is set</code></div>
        </div>
      </Card>
      <Card title="Operator Notes">
        <EmptyState title="No hardware selected" message="Set serial environment variables and use the Devices page to confirm host status." />
      </Card>
    </section>
  );
}

function Card({
  title,
  children,
  sourceMode,
  researchOnly
}: {
  title: string;
  children: ReactNode;
  sourceMode?: SourceMode | null;
  researchOnly?: boolean;
}) {
  return (
    <section className="card">
      <div className="cardHeader">
        <h2>{title}</h2>
        {researchOnly ? <span className="researchOnlyBadge" title="Research-only proxy, not validated physiology">research only</span> : null}
        {sourceMode ? <SourceBadge mode={sourceMode} /> : null}
      </div>
      {children}
    </section>
  );
}

function confidenceFrom(value: number | null | undefined): "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" {
  if (value == null) return "UNKNOWN";
  if (value >= 0.75) return "HIGH";
  if (value >= 0.45) return "MEDIUM";
  return "LOW";
}

// The previous build derived an HRV proxy (in ms) and a Stress / affect tone
// from CSI motion + quality. Both were heuristics dressed up in clinical units
// or affective labels; per CLAUDE.md they are forbidden in V0. They were
// removed in favour of RespirationCard + HeartBandCard with FFT/ACF
// cross-check, harmonic check, and stillness gate. See deriveVitalSummary.

function BiorhythmStatus({ latest }: { latest: DerivedWindow | null }) {
  if (!latest) return null;
  const respConf = confidenceFrom(latest.respiration_confidence ?? null);
  const hrConf = confidenceFrom(latest.heart_rate_proxy_confidence ?? null);
  const window = latest.biorhythm_window_seconds;
  const rate = latest.biorhythm_sample_rate_hz;
  return (
    <div className="bandBadgeRow">
      <span className={`bandBadge confidence-${respConf.toLowerCase()}`}>
        resp {latest.respiration_bpm == null ? "--" : `${latest.respiration_bpm.toFixed(1)} bpm`} · {respConf}
      </span>
      <span className={`bandBadge confidence-${hrConf.toLowerCase()}`}>
        peak 0.8–2.5 Hz {latest.heart_rate_proxy_bpm == null ? "--" : `${latest.heart_rate_proxy_bpm.toFixed(0)} bpm`} · {hrConf}
      </span>
      <span className="bandBadge">
        FFT window {window != null ? `${window.toFixed(1)} s` : "--"} · {rate != null ? `${rate.toFixed(1)} Hz` : "-- Hz"}
      </span>
    </div>
  );
}

