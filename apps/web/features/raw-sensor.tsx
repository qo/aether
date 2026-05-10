"use client";

/**
 * Raw Sensor Data — the diagnostics surface that exposes everything the
 * runtime knows per-frame and per-link. Renders four panels:
 *
 *   1. Link Diagnostics — observed Hz vs expected Hz, jitter percentiles,
 *      firmware drop count + queue depth (Phase A surfaces).
 *   2. Frame Inspector — last-N raw frames in a virtualised table.
 *   3. Live Spectrograms — amplitude / phase / SNR-vs-baseline as time x
 *      subcarrier heatmaps.
 *   4. Subcarrier Health — per-subcarrier baseline std + SNR + which subset
 *      is currently driving motion (Phase B's responsive set).
 *
 * Every value labelled with its provenance: [Sensed], [Operator-supplied],
 * or [Computed]. Visual chrome comes from the shared design system in
 * globals.css — .panel, .stat-tile, .banner.
 */

import { useEffect, useMemo, useState } from "react";
import {
  getLinkDiagnostics,
  getSubcarrierDiagnostics,
} from "../lib/api";
import type {
  LinkDiagnostics,
  SubcarrierDiagnostics,
} from "../lib/types";
import { useLiveStream } from "../lib/use-live-stream";

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <span>{title}</span>
        {hint && <span className="meta">{hint}</span>}
      </header>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "bad";
}) {
  const cls =
    tone === "good"
      ? "stat-tile good"
      : tone === "warn"
      ? "stat-tile warn"
      : tone === "bad"
      ? "stat-tile danger"
      : "stat-tile";
  return (
    <div className={cls}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toFixed(digits);
}

function LinkDiagnosticsCard() {
  const [link, setLink] = useState<LinkDiagnostics | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await getLinkDiagnostics();
        if (alive) setLink(next);
      } catch {
        if (alive) setLink(null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const hzTone = useMemo(() => {
    if (!link || link.observed_packet_rate_hz == null) return undefined;
    const ratio = link.observed_packet_rate_hz / Math.max(link.expected_packet_rate_hz, 1);
    if (ratio >= 0.85) return "good";
    if (ratio >= 0.5) return "warn";
    return "bad";
  }, [link]);

  return (
    <Panel title="LINK DIAGNOSTICS" hint="[Sensed] · /diagnostics/link · 1.5 s poll">
      {link == null ? (
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
          API offline or no frames yet.
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          <StatTile
            label="Observed rate"
            value={
              link.observed_packet_rate_hz == null
                ? "no frames"
                : `${fmt(link.observed_packet_rate_hz, 1)} Hz`
            }
            sub={`expected ${fmt(link.expected_packet_rate_hz, 1)} Hz (${link.expected_rate_source})`}
            tone={hzTone}
          />
          <StatTile
            label="Inter-arrival p50"
            value={
              link.inter_arrival_p50_ms == null
                ? "—"
                : `${fmt(link.inter_arrival_p50_ms, 1)} ms`
            }
            sub={
              link.inter_arrival_p50_ms == null
                ? "needs frames"
                : `p99 ${fmt(link.inter_arrival_p99_ms, 1)} ms · max ${fmt(link.inter_arrival_max_ms, 1)} ms`
            }
          />
          <StatTile
            label="Jitter (σ)"
            value={
              link.inter_arrival_jitter_ms == null
                ? "—"
                : `${fmt(link.inter_arrival_jitter_ms, 1)} ms`
            }
            sub={`first-word-invalid ${
              link.frames_seen > 0 ? fmt(link.first_word_invalid_ratio * 100, 1) + "%" : "—"
            }`}
          />
          <StatTile
            label="RSSI"
            value={link.rssi_p50_dbm == null ? "—" : `${fmt(link.rssi_p50_dbm, 0)} dBm`}
            sub={
              link.rssi_p50_dbm == null
                ? "no frames"
                : `σ ${fmt(link.rssi_std_dbm, 1)} dB · noise ${fmt(link.noise_floor_p50_dbm, 0)} dBm`
            }
            tone={
              link.rssi_std_dbm != null && link.rssi_std_dbm > 4
                ? "warn"
                : link.rssi_p50_dbm != null
                ? "good"
                : undefined
            }
          />
          <StatTile
            label="Frames seen"
            value={`${link.frames_seen}`}
            sub={`firmware: ${link.firmware_packets_seen ?? "no heartbeat"}`}
          />
          <StatTile
            label="Firmware dropped"
            value={`${link.firmware_dropped ?? "—"}`}
            sub={
              link.firmware_packets_seen == null
                ? "no heartbeat"
                : "from CSI queue overflow"
            }
            tone={
              link.firmware_dropped != null && link.firmware_dropped > 0
                ? "bad"
                : link.firmware_packets_seen != null
                ? "good"
                : undefined
            }
          />
          <StatTile
            label="Queue depth"
            value={`${link.firmware_queue_depth ?? "—"}`}
            sub={
              link.firmware_queue_depth == null
                ? "no heartbeat"
                : link.firmware_queue_depth > 4
                ? "firmware-side backlog (UART-bound)"
                : "ok"
            }
            tone={
              link.firmware_queue_depth != null && link.firmware_queue_depth > 4
                ? "warn"
                : link.firmware_queue_depth != null
                ? "good"
                : undefined
            }
          />
          <StatTile
            label="Last frame age"
            value={
              link.last_frame_age_s == null
                ? "—"
                : `${link.last_frame_age_s.toFixed(1)} s`
            }
            sub={link.rate_stable ? "rate stable" : "rate not yet stable"}
            tone={
              link.last_frame_age_s != null && link.last_frame_age_s > 2
                ? "bad"
                : link.last_frame_age_s != null
                ? "good"
                : undefined
            }
          />
        </div>
      )}
      {link?.notes && link.notes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {link.notes.map((note) => (
            <div key={note} className="banner warn">
              {note}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function MiniHeatmap({
  data,
  width = 600,
  height = 120,
  title,
}: {
  data: number[][];
  width?: number;
  height?: number;
  title: string;
}) {
  // data is [time][subcarrier]; height clamped per-cell for cheap render.
  const rows = data.length;
  const cols = data[0]?.length ?? 0;
  if (rows === 0 || cols === 0) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-faint)",
          fontSize: 12,
          border: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        {title}: warming up…
      </div>
    );
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of data) {
    for (const v of row) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const span = Math.max(1e-6, hi - lo);
  const cellW = width / rows;
  const cellH = height / cols;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.08em",
          color: "var(--text-faint)",
          textTransform: "uppercase",
        }}
      >
        {title} ({rows}×{cols}, range {lo.toFixed(2)}…{hi.toFixed(2)})
      </div>
      <svg width={width} height={height} style={{ background: "var(--bg-deep)", border: "1px solid var(--border)" }}>
        {data.map((row, t) =>
          row.map((v, k) => {
            const norm = (v - lo) / span;
            // Map onto a forest-green→pulse-green ramp so the spectrogram
            // lives in the same palette as the rest of the app.
            const lightness = 18 + norm * 50;
            const sat = 35 + norm * 45;
            return (
              <rect
                key={`${t}-${k}`}
                x={t * cellW}
                y={(cols - 1 - k) * cellH}
                width={Math.max(1, cellW)}
                height={Math.max(1, cellH)}
                fill={`hsl(140, ${sat}%, ${lightness}%)`}
              />
            );
          })
        )}
      </svg>
    </div>
  );
}

function SpectrogramsCard() {
  const { windows, status } = useLiveStream({ topics: ["derived_window"], windowBuffer: 80 });
  const ampMatrix = useMemo(() => windows.map((w) => w.amplitude_mean ?? []), [windows]);
  const phaseMatrix = useMemo(() => windows.map((w) => w.phase_unwrapped_std ?? []), [windows]);
  return (
    <Panel
      title="LIVE SPECTROGRAMS"
      hint={`[Sensed] · ws=${status} · last ${windows.length} windows`}
    >
      <MiniHeatmap data={ampMatrix} title="amplitude_mean (per subcarrier × time)" height={140} />
      <MiniHeatmap data={phaseMatrix} title="phase_unwrapped_std (per subcarrier × time)" height={140} />
    </Panel>
  );
}

function SubcarrierHealthCard() {
  const [diag, setDiag] = useState<SubcarrierDiagnostics | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await getSubcarrierDiagnostics();
        if (alive) setDiag(next);
      } catch {
        if (alive) setDiag(null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!diag || !diag.is_calibrated) {
    return (
      <Panel title="SUBCARRIER HEALTH" hint="needs baseline calibration">
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
          No baseline yet. Calibrate the empty room from the Live Room page to
          unlock per-subcarrier SNR and the responsive-subset highlights.
        </p>
      </Panel>
    );
  }

  const max = Math.max(...diag.amplitude_std, 1e-6);
  const responsive = new Set(diag.responsive_indices);

  return (
    <Panel
      title="SUBCARRIER HEALTH"
      hint={`[Sensed] · ${diag.subcarrier_count} subcarriers · ${diag.edges_dropped} dropped at edges`}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120, paddingTop: 12 }}>
        {diag.amplitude_std.map((std, i) => {
          const h = (std / max) * 100;
          const inResponsive = responsive.has(i);
          return (
            <div
              key={i}
              title={`#${i}  std=${std.toFixed(2)}  ${inResponsive ? "(responsive)" : ""}`}
              style={{
                width: 6,
                height: `${Math.max(4, h)}%`,
                background: inResponsive ? "var(--accent-bright)" : "var(--text-faint)",
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 16,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          textTransform: "uppercase",
        }}
      >
        <span>
          <span style={{ color: "var(--accent-bright)" }}>■</span> responsive set ({diag.responsive_indices.length})
        </span>
        <span>
          <span style={{ color: "var(--text-faint)" }}>■</span> dormant
        </span>
      </div>
    </Panel>
  );
}

function FrameInspectorCard() {
  const { frames, status } = useLiveStream({ topics: ["derived_window", "raw_frame"], frameBuffer: 80 });
  const recent = frames.slice(-30).reverse();
  return (
    <Panel
      title="FRAME INSPECTOR"
      hint={`[Sensed] · ws=${status} · raw_frame topic · last ${recent.length}`}
    >
      <div
        style={{
          overflow: "auto",
          maxHeight: 360,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{
                position: "sticky",
                top: 0,
                background: "var(--bg)",
                textAlign: "left",
                color: "var(--text-faint)",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                fontSize: 10,
              }}
            >
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>seq</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>ts_host_ns</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>RSSI</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>noise</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>len</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>fwi</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>chan</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>cwb</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>sig</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>iq[0..7]</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: 16, color: "var(--text-muted)", textAlign: "center" }}>
                  Subscribed to raw_frame — waiting for first packet.
                </td>
              </tr>
            )}
            {recent.map((f) => (
              <tr key={`${f.seq}-${f.ts_host_ns}`} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 8px" }}>{f.seq}</td>
                <td style={{ padding: "4px 8px" }}>{f.ts_host_ns}</td>
                <td style={{ padding: "4px 8px" }}>{f.rssi_dbm}</td>
                <td style={{ padding: "4px 8px" }}>{f.noise_floor_dbm}</td>
                <td style={{ padding: "4px 8px" }}>{f.payload_len}</td>
                <td
                  style={{
                    padding: "4px 8px",
                    color: f.first_word_invalid ? "var(--status-danger)" : "var(--status-good)",
                  }}
                >
                  {f.first_word_invalid ? "Y" : "N"}
                </td>
                <td style={{ padding: "4px 8px" }}>{f.channel}</td>
                <td style={{ padding: "4px 8px" }}>{f.cwb}</td>
                <td style={{ padding: "4px 8px" }}>{f.sig_mode}</td>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                  {f.raw_iq_int8.slice(0, 8).join(",")}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export default function RawSensorPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <LinkDiagnosticsCard />
      <SpectrogramsCard />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <SubcarrierHealthCard />
        <FrameInspectorCard />
      </div>
    </div>
  );
}
