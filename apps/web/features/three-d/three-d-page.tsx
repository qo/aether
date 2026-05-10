"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ThreeDScene, type CameraPreset } from "./scene";
import { getLinkDiagnostics, getRoomGeometry } from "../../lib/api";
import type { LinkDiagnostics, RoomGeometry } from "../../lib/types";
import { useLiveStream } from "../../lib/use-live-stream";

function HUDPanel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "var(--hud)",
        border: "1px solid var(--border-strong)",
        padding: 10,
        color: "var(--text)",
        fontSize: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CameraPresetButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      type="button"
      style={{
        padding: "4px 10px",
        background: active ? "var(--accent)" : "transparent",
        border: active ? "1px solid var(--accent-bright)" : "1px solid var(--border-strong)",
        color: active ? "var(--text-on-accent)" : "var(--text)",
        cursor: "pointer",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {label}
    </button>
  );
}

function LayerToggle({ active, label, onToggle }: { active: boolean; label: string; onToggle: () => void }) {
  return (
    <label
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        userSelect: "none",
        fontSize: 11,
        color: active ? "var(--text)" : "var(--text-muted)",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          background: active ? "var(--accent)" : "transparent",
          border: "1px solid var(--accent)",
        }}
      />
      {label}
    </label>
  );
}

function SetupRequired({ geometry }: { geometry: RoomGeometry | null }) {
  const reasons: string[] = [];
  if (!geometry) reasons.push("Could not reach the API.");
  else {
    if (!geometry.room_extent_m) reasons.push("Room dimensions not entered.");
    if (!geometry.tx_position_m) reasons.push("TX position not entered.");
    if (!geometry.rx_position_m) reasons.push("RX position not entered.");
  }
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-deep)",
        color: "var(--text)",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 460,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          padding: 24,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 600,
            marginBottom: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-strong)",
          }}
        >
          3D view requires geometry
        </div>
        <p style={{ margin: "0 0 12px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
          This view will not draw a placeholder room. Tape-measure the values below and save them on
          the Devices page, then come back.
        </p>
        <ul style={{ margin: "0 0 16px", paddingLeft: 18, fontSize: 12, color: "var(--status-warn)" }}>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <a
          href="/devices-v2"
          style={{
            display: "inline-block",
            padding: "8px 14px",
            background: "var(--accent)",
            border: "1px solid var(--accent)",
            color: "var(--text-on-accent)",
            textDecoration: "none",
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          → Open Devices to enter geometry
        </a>
      </div>
    </div>
  );
}

export default function ThreeDPage() {
  const params = useSearchParams();
  const isEmbed = params?.get("embed") === "1";

  const [geometry, setGeometry] = useState<RoomGeometry | null>(null);
  const [geometryLoaded, setGeometryLoaded] = useState(false);
  const [link, setLink] = useState<LinkDiagnostics | null>(null);
  const [layers, setLayers] = useState({
    pulses: true,
    carpet: true,
    subject: true,
    grid: true,
  });
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>("free");
  const [rawSubscribed, setRawSubscribed] = useState(true);

  const { windows, frames, summary } = useLiveStream({
    topics: rawSubscribed ? ["derived_window", "raw_frame"] : ["derived_window"],
    windowBuffer: 30,
    frameBuffer: 60,
  });
  const latestWindow = windows[windows.length - 1] ?? null;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const g = await getRoomGeometry();
        if (alive) {
          setGeometry(g);
          setGeometryLoaded(true);
        }
      } catch {
        if (alive) {
          setGeometry(null);
          setGeometryLoaded(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const l = await getLinkDiagnostics();
        if (alive) setLink(l);
      } catch {
        if (alive) setLink(null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "1") setCameraPreset("birdseye");
      else if (event.key === "2") setCameraPreset("side");
      else if (event.key === "3") setCameraPreset("front");
      else if (event.key === "4") setCameraPreset("free");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const popOut = () => {
    const w = window.open("/3d?embed=1", "aether-3d", "width=1280,height=800");
    w?.focus();
  };

  if (!geometryLoaded) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          minHeight: 360,
        }}
      >
        Loading geometry from API…
      </div>
    );
  }

  if (
    geometry == null ||
    !geometry.room_extent_m ||
    !geometry.tx_position_m ||
    !geometry.rx_position_m
  ) {
    return <SetupRequired geometry={geometry} />;
  }

  // Narrow the type for the scene props.
  const completeGeometry = geometry as RoomGeometry & {
    room_extent_m: [number, number, number];
    tx_position_m: [number, number, number];
    rx_position_m: [number, number, number];
  };

  const sourceMode = summary?.source_mode ?? latestWindow?.source_mode ?? null;
  const showReplayBadge = sourceMode === "REPLAY";
  const haveFrames = frames.length > 0;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: isEmbed ? "100vh" : "calc(100vh - var(--topbar-h) - 32px)",
        minHeight: 480,
        background: "var(--bg-deep)",
        border: isEmbed ? "none" : "1px solid var(--border)",
      }}
    >
      <ThreeDScene
        geometry={completeGeometry}
        latestWindow={latestWindow}
        latestFrames={frames}
        layers={layers}
        cameraPreset={cameraPreset}
      />

      <div style={{ position: "absolute", top: 12, left: 12, display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
        <HUDPanel>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <strong
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-strong)",
              }}
            >
              3D Wave View
            </strong>
            <span
              style={{
                marginLeft: "auto",
                padding: "2px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.08em",
                background: showReplayBadge
                  ? "rgba(212, 164, 78, 0.12)"
                  : sourceMode
                  ? "rgba(78, 230, 138, 0.12)"
                  : "rgba(208, 90, 78, 0.12)",
                color: showReplayBadge
                  ? "var(--status-warn)"
                  : sourceMode
                  ? "var(--status-good)"
                  : "var(--status-danger)",
                border: `1px solid ${
                  showReplayBadge
                    ? "var(--status-warn)"
                    : sourceMode
                    ? "var(--status-good)"
                    : "var(--status-danger)"
                }`,
              }}
            >
              {sourceMode ?? "NO STREAM"}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto auto",
              gap: "2px 12px",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span style={{ color: "var(--text-faint)" }}>obs Hz</span>
            <span>{link?.observed_packet_rate_hz != null ? link.observed_packet_rate_hz.toFixed(1) : "—"}</span>
            <span style={{ color: "var(--text-faint)" }}>RSSI</span>
            <span>{link?.rssi_p50_dbm != null ? `${link.rssi_p50_dbm} dBm` : "—"}</span>
            <span style={{ color: "var(--text-faint)" }}>motion</span>
            <span>{latestWindow ? latestWindow.motion_score.toFixed(2) : "—"}</span>
            <span style={{ color: "var(--text-faint)" }}>occ</span>
            <span>{latestWindow ? latestWindow.occupancy_score.toFixed(2) : "—"}</span>
          </div>
          {!haveFrames && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--status-danger)" }}>
              No raw_frame events received. Pulses will not draw until the link delivers frames.
            </div>
          )}
        </HUDPanel>
      </div>

      <div style={{ position: "absolute", top: 12, right: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <HUDPanel>
          <div
            style={{
              marginBottom: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-faint)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            CAMERA (1-4)
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <CameraPresetButton active={cameraPreset === "birdseye"} label="Birds-eye" onClick={() => setCameraPreset("birdseye")} />
            <CameraPresetButton active={cameraPreset === "side"} label="Side" onClick={() => setCameraPreset("side")} />
            <CameraPresetButton active={cameraPreset === "front"} label="Front" onClick={() => setCameraPreset("front")} />
            <CameraPresetButton active={cameraPreset === "free"} label="Free" onClick={() => setCameraPreset("free")} />
          </div>
        </HUDPanel>
        {!isEmbed && (
          <HUDPanel>
            <button
              onClick={popOut}
              type="button"
              className="btn"
              style={{ width: "100%", justifyContent: "center" }}
            >
              ⇗ Pop out to standalone window
            </button>
          </HUDPanel>
        )}
      </div>

      <div style={{ position: "absolute", bottom: 12, left: 12, maxWidth: 540 }}>
        <HUDPanel>
          <div
            style={{
              marginBottom: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-faint)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            LAYERS
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <LayerToggle active={layers.pulses} label="pulses (real frames only)" onToggle={() => setLayers((s) => ({ ...s, pulses: !s.pulses }))} />
            <LayerToggle active={layers.carpet} label="subcarrier carpet" onToggle={() => setLayers((s) => ({ ...s, carpet: !s.carpet }))} />
            <LayerToggle
              active={layers.subject && geometry.subject_position_m != null}
              label={`subject blob ${geometry.subject_position_m == null ? "(not placed)" : ""}`.trim()}
              onToggle={() => setLayers((s) => ({ ...s, subject: !s.subject }))}
            />
            <LayerToggle active={layers.grid} label="floor grid" onToggle={() => setLayers((s) => ({ ...s, grid: !s.grid }))} />
            <LayerToggle active={rawSubscribed} label="subscribe to raw_frame" onToggle={() => setRawSubscribed((s) => !s)} />
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
            All antenna and subject positions are <strong>operator-entered</strong>. Pulses, subject
            intensity, and subcarrier carpet heights are <strong>sensed</strong>. Wave propagation
            speed is slowed for human eyes — it is <strong>not</strong> the speed of light.
          </div>
        </HUDPanel>
      </div>
    </div>
  );
}
