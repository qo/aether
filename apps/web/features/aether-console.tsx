"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  Bell,
  BookOpen,
  Database,
  FlaskConical,
  HardDrive,
  Home,
  MessageSquare,
  Radio,
  RefreshCw,
  Settings,
  Square,
  Waves,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
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
  resetCalibration,
  startCalibration,
  startSession,
  stopSession
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
  { label: "HR proxy (bpm)", stroke: "#EF4444", pick: (w) => w.heart_rate_proxy_bpm, scale: "bpm" },
  { label: "Resp confidence", stroke: "#3B82F6", pick: (w) => w.respiration_confidence ?? null, dash: [4, 3] },
  { label: "HR confidence", stroke: "#F59E0B", pick: (w) => w.heart_rate_proxy_confidence ?? null, dash: [4, 3] }
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

export function RadioVisionConsole() {
  const [page, setPage] = useState<PageName>("Live Room");
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

  useEffect(() => {
    void refreshMetadata();
    const disconnect = connectLive(
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
      disconnect();
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
    <main className="appShell">
      <Sidebar
        page={page}
        setPage={setPage}
        sourceMode={sourceMode}
        connectionStatus={connectionStatus}
        healthStatus={error ? "unavailable" : "healthy"}
      />
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
              starting={startingSession}
              boardStreaming={boardStreaming}
              framesEverReceived={framesEverReceived}
              latestWindowAgeSec={latestWindowAgeSec}
              recentFramePerSec={recentFramePerSec}
              hasSession={hasSession}
              apiReachable={apiReachable}
              onRefresh={() => void refreshMetadata()}
              onStartSession={() => void quickStartSession()}
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
    </main>
  );

  async function stopActiveSession() {
    if (!activeSessionId) return;
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

function Sidebar({
  page,
  setPage,
  sourceMode,
  connectionStatus,
  healthStatus
}: {
  page: PageName;
  setPage: (page: PageName) => void;
  sourceMode: SourceMode | null;
  connectionStatus: string;
  healthStatus: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brandMark">Æ</span>
        <strong>Aether</strong>
      </div>
      <nav className="sideNav" aria-label="Primary navigation">
        {navSections.map((section) => (
          <div className="navSection" key={section.label}>
            <span className="navLabel">{section.label}</span>
            {section.items.map((item) => (
              <button className={page === item ? "navItem active" : "navItem"} key={item} onClick={() => setPage(item)}>
                {navIcon(item)}
                <span>{item}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebarStatus">
        <SourceBadge mode={connectionStatus === "connected" ? sourceMode : null} status={connectionStatus} />
        <div className="statusRow">
          <StatusDot status={healthStatus === "healthy" ? "success" : "danger"} />
          <span>Host service {healthStatus}</span>
        </div>
        <div className="statusRow">
          <StatusDot status="muted" />
          <span>Firmware unknown</span>
        </div>
      </div>
    </aside>
  );
}

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
  starting,
  boardStreaming,
  framesEverReceived,
  latestWindowAgeSec,
  recentFramePerSec,
  hasSession,
  apiReachable,
  onRefresh,
  onStartSession,
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
  starting: boolean;
  boardStreaming: boolean;
  framesEverReceived: boolean;
  latestWindowAgeSec: number | null;
  recentFramePerSec: number | null;
  hasSession: boolean;
  apiReachable: boolean;
  onRefresh: () => void;
  onStartSession: () => void;
  calibration: CalibrationStatus | null;
  calibrationBusy: boolean;
  onCalibrate: (seconds: number) => void;
  onCalibrationReset: () => void;
  onCalibrationCancel: () => void;
}) {
  const vital = deriveVitalSummary(latest);
  return (
    <div className="pageStack">
      <SensingOverview
        latest={latest}
        summary={summary}
        connectionStatus={connectionStatus}
        serialPort={serialPort}
        sourceMode={sourceMode}
        boardStreaming={boardStreaming}
        latestWindowAgeSec={latestWindowAgeSec}
        recentFramePerSec={recentFramePerSec}
        onRefresh={onRefresh}
      />
      <ReadinessChecklist
        apiReachable={apiReachable}
        connectionStatus={connectionStatus}
        sourceMode={sourceMode}
        serialPort={serialPort}
        hasSession={hasSession}
        boardStreaming={boardStreaming}
        framesEverReceived={framesEverReceived}
        calibrated={Boolean(calibration?.is_calibrated || latest?.baseline_calibrated)}
      />
      {disconnected ? (
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
      <section className="liveRoomGrid">
        <div className="columnStack sideColumn">
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
          <CalibrationCard
            latest={latest}
            calibration={calibration}
            busy={calibrationBusy}
            onCalibrate={onCalibrate}
            onReset={onCalibrationReset}
            onCancel={onCalibrationCancel}
          />
        </div>
        <div className="columnStack centerColumn">
          <Card title="Live Trends" sourceMode={latest?.source_mode ?? null}>
            <TrendChart
              windows={windows}
              ariaLabel="Motion, occupancy, anomaly, and quality trend"
              series={trendSeries}
              height={260}
            />
          </Card>
          <Card title="Biorhythm Spectrum" sourceMode={latest?.source_mode ?? null} researchOnly>
            <TrendChart
              windows={windows}
              ariaLabel="Respiration and heart-rate proxy trend"
              series={biorhythmSeries}
              height={200}
            />
            <BiorhythmStatus latest={latest} />
          </Card>
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
        </div>
        <div className="columnStack sideColumn">
          <RespirationCard latest={latest} windows={windows} vital={vital} />
          <HeartBandCard latest={latest} windows={windows} vital={vital} />
          <FidgetEnergyCard latest={latest} windows={windows} />
          <MetricCard
            title="Occupancy score"
            value={latest ? latest.occupancy_score.toFixed(2) : null}
            detail={
              latest?.baseline_calibrated
                ? "Anomaly-vs-baseline score. Backend-derived."
                : "Uncalibrated - run baseline before reading this."
            }
            confidence={confidenceFrom(latest?.quality_score)}
            sparkline={windows.map((window) => window.occupancy_score)}
          />
          <MetricCard
            title="Motion score"
            value={latest ? latest.motion_score.toFixed(2) : null}
            detail="Bandpass-filtered, baseline-subtracted RMS across subcarriers."
            confidence={confidenceFrom(latest?.quality_score)}
            sparkline={windows.map((window) => window.motion_score)}
          />
          <RoomSummaryCard summary={summary} />
          <Card title="Event Ticker">
            <EmptyState title="No events available" message="Events will appear after labels are written during an active session." />
          </Card>
        </div>
      </section>
    </div>
  );
}

function SensingOverview({
  latest,
  summary,
  connectionStatus,
  serialPort,
  sourceMode,
  boardStreaming,
  latestWindowAgeSec,
  recentFramePerSec,
  onRefresh
}: {
  latest: DerivedWindow | null;
  summary: RoomSummary | null;
  connectionStatus: string;
  serialPort: string | null;
  sourceMode: SourceMode | null;
  boardStreaming: boolean;
  latestWindowAgeSec: number | null;
  recentFramePerSec: number | null;
  onRefresh: () => void;
}) {
  // The headline word for the operator: "streaming" beats "connected" because
  // the WS being open does NOT imply the RX board is actually emitting CSI.
  const liveLabel = boardStreaming
    ? "streaming"
    : latestWindowAgeSec != null
    ? `stalled (${latestWindowAgeSec.toFixed(0)} s)`
    : connectionStatus === "connected"
    ? "no frames"
    : connectionStatus;
  const rateLabel = recentFramePerSec != null ? `${recentFramePerSec.toFixed(1)} Hz` : "--";
  return (
    <section className="overviewBand">
      <div>
        <span className="eyebrow">Contactless CSI Sensing</span>
        <h2>Realtime CSI motion &amp; occupancy with research-only physiology proxies</h2>
        <p>
          Two CSI-capable ESP32-S3 nodes bracket the seated subject. The UI streams derived RF windows from the API
          over <code>/ws/live</code> and surfaces motion, occupancy, RSSI, packet rate, and a CSI waterfall. Heart-rate,
          HRV, fidget and stress cards are CSI motion proxies, not validated physiology.
        </p>
        {/*
         * suppressHydrationWarning on each dynamic <span>: the visible text
         * is derived from live state (connectionStatus, summary, frame age)
         * and the client overwrites it within a tick of hydration anyway.
         * Suppressing here prevents a future state-init change from blowing
         * up React the way it did when wallClockMs used Date.now().
         */}
        <div className="runtimeNoticeRow">
          <span suppressHydrationWarning>Mode <code>{sourceMode ?? "unknown"}</code></span>
          <span suppressHydrationWarning>Serial <code>{serialPort ?? "unset"}</code></span>
          <span suppressHydrationWarning>WS <code>{connectionStatus}</code></span>
          <span suppressHydrationWarning>Stream <code>{liveLabel}</code></span>
        </div>
      </div>
      <div className="overviewStats">
        <div><span>Stream</span><strong suppressHydrationWarning>{liveLabel}</strong></div>
        <div><span>Rate</span><strong suppressHydrationWarning>{rateLabel}</strong></div>
        <div><span>Frames</span><strong suppressHydrationWarning>{latest?.packet_count ?? "--"}</strong></div>
        <div><span>Room</span><strong suppressHydrationWarning>{summary?.status ?? summary?.occupancy ?? "waiting"}</strong></div>
        <button className="iconButton" onClick={onRefresh} aria-label="Refresh runtime state" type="button">
          <RefreshCw size={16} />
        </button>
      </div>
    </section>
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
    <Card title="Periodic motion in HR band (research)" sourceMode={latest?.source_mode ?? null} researchOnly>
      {vital.stillnessGated ? (
        <div className="gateBanner">Movement detected — HR-band reading suppressed.</div>
      ) : null}
      {vital.looksLikeHarmonic ? (
        <div className="harmonicBanner">
          Peak frequency is ~2× the respiration peak — likely a respiration harmonic, not heart rate.
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
        HR* {latest.heart_rate_proxy_bpm == null ? "--" : `${latest.heart_rate_proxy_bpm.toFixed(0)} bpm`} · {hrConf}
      </span>
      <span className="bandBadge">
        FFT window {window != null ? `${window.toFixed(1)} s` : "--"} · {rate != null ? `${rate.toFixed(1)} Hz` : "-- Hz"}
      </span>
    </div>
  );
}

function navIcon(item: string) {
  const props = { size: 16 };
  if (item === "Live Room") return <Home {...props} />;
  if (item === "Devices") return <HardDrive {...props} />;
  if (item === "Experiment Console") return <FlaskConical {...props} />;
  if (item === "Data Explorer") return <Database {...props} />;
  if (item === "Knowledge Base") return <BookOpen {...props} />;
  if (item === "Agent Console") return <MessageSquare {...props} />;
  if (item === "Settings") return <Settings {...props} />;
  return <Radio {...props} />;
}
