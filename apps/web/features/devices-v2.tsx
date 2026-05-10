"use client";

/**
 * Devices v2 — link telemetry + room geometry editor.
 *
 * Strict honesty mode: every field shows the live value from the API. There
 * are no placeholder positions, no faked dimensions, no synthesised RSSI.
 * Anything missing renders as "—" or "not entered yet". The 3D view is gated
 * on this page producing a complete geometry; until then `/3d` shows a
 * setup-required screen. All chrome is from the shared design system.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getDevices,
  getLinkDiagnostics,
  getRoomGeometry,
  putRoomGeometry,
} from "../lib/api";
import type { LinkDiagnostics, RoomGeometry } from "../lib/types";

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
      <div className="panel-body">{children}</div>
    </section>
  );
}

function fmtNum(value: number | null | undefined, digits = 2, suffix = ""): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${suffix}`;
}

function LinkPanel() {
  const [link, setLink] = useState<LinkDiagnostics | null>(null);
  const [devices, setDevices] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [l, d] = await Promise.all([getLinkDiagnostics(), getDevices()]);
        if (alive) {
          setLink(l);
          setDevices(d);
          setError(null);
        }
      } catch (err) {
        if (alive) {
          setLink(null);
          setError(String(err));
        }
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  const rx = (devices?.rx ?? null) as Record<string, unknown> | null;
  const haveFrames = link != null && link.frames_seen > 0;
  return (
    <Panel title="LINK STATE" hint="[Sensed] · /devices + /diagnostics/link">
      {error && <div className="banner danger">API unreachable: {error}</div>}
      <dl className="kvList" style={{ gridTemplateColumns: "max-content 1fr" }}>
        <dt>RX serial port</dt>
        <dd>{(rx?.serial_port as string) ?? "not configured"}</dd>
        <dt>baud</dt>
        <dd>{(rx?.baud as number) ?? "—"}</dd>
        <dt>frames received</dt>
        <dd>{link ? link.frames_seen : "—"}</dd>
        <dt>observed Hz</dt>
        <dd>{haveFrames ? fmtNum(link!.observed_packet_rate_hz, 2) : "no frames yet"}</dd>
        <dt>expected Hz</dt>
        <dd>
          {link
            ? `${link.expected_packet_rate_hz.toFixed(2)} (${link.expected_rate_source})`
            : "—"}
        </dd>
        <dt>p50 / p99 ms</dt>
        <dd>
          {haveFrames && link!.inter_arrival_p50_ms != null
            ? `${link!.inter_arrival_p50_ms.toFixed(1)} / ${(link!.inter_arrival_p99_ms ?? 0).toFixed(1)}`
            : "—"}
        </dd>
        <dt>RSSI p50 / σ</dt>
        <dd>
          {haveFrames && link!.rssi_p50_dbm != null
            ? `${link!.rssi_p50_dbm} dBm / ${(link!.rssi_std_dbm ?? 0).toFixed(1)} dB`
            : "—"}
        </dd>
        <dt>RSSI-implied distance</dt>
        <dd>
          {link?.rssi_implied_distance_m != null
            ? `${link.rssi_implied_distance_m.toFixed(2)} m (rough; n=3 indoor)`
            : "—"}
        </dd>
        <dt>FW packets / dropped / queue</dt>
        <dd>
          {link
            ? `${link.firmware_packets_seen ?? "no heartbeat"} / ${
                link.firmware_dropped ?? "—"
              } / ${link.firmware_queue_depth ?? "—"}`
            : "—"}
        </dd>
        <dt>last frame age</dt>
        <dd>
          {link?.last_frame_age_s != null ? `${link.last_frame_age_s.toFixed(1)} s` : "—"}
        </dd>
      </dl>
      {link?.notes && link.notes.length > 0 && (
        <ul style={{ margin: "12px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--status-warn)" }}>
          {link.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface FloorplanProps {
  geometry: RoomGeometry;
  draftRoom: [number, number, number] | null;
  draftTx: [number, number, number] | null;
  draftRx: [number, number, number] | null;
  draftSubject: [number, number, number] | null;
  onMoveTx: (xz: [number, number]) => void;
  onMoveRx: (xz: [number, number]) => void;
  onMoveSubject: (xz: [number, number]) => void;
}

function Floorplan(props: FloorplanProps) {
  const { draftRoom, draftTx, draftRx, draftSubject, onMoveTx, onMoveRx, onMoveSubject } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<"tx" | "rx" | "subject" | null>(null);
  const W = 480;
  const H = 320;

  if (!draftRoom) {
    return (
      <div
        style={{
          width: W,
          height: H,
          background: "var(--bg-deep)",
          border: "1px dashed var(--border-strong)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        Enter the room dimensions on the right to enable the floorplan.
      </div>
    );
  }

  const xMax = Math.max(0.5, draftRoom[0]);
  const zMax = Math.max(0.5, draftRoom[2]);
  const toScreen = (x: number, z: number) => ({
    sx: (x / xMax) * W,
    sy: (z / zMax) * H,
  });
  const fromScreen = (sx: number, sy: number) => ({
    x: Math.max(0, Math.min(xMax, (sx / W) * xMax)),
    z: Math.max(0, Math.min(zMax, (sy / H) * zMax)),
  });

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const { x, z } = fromScreen(sx, sy);
    if (drag === "tx") onMoveTx([x, z]);
    else if (drag === "rx") onMoveRx([x, z]);
    else if (drag === "subject") onMoveSubject([x, z]);
  };

  const tx = draftTx ? toScreen(draftTx[0], draftTx[2]) : null;
  const rx = draftRx ? toScreen(draftRx[0], draftRx[2]) : null;
  const sub = draftSubject ? toScreen(draftSubject[0], draftSubject[2]) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.08em",
          color: "var(--text-faint)",
          textTransform: "uppercase",
        }}
      >
        Top-down floorplan ({xMax.toFixed(1)}m × {zMax.toFixed(1)}m). Drag markers to move.
      </div>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        style={{
          background: "var(--bg-deep)",
          cursor: drag ? "grabbing" : "default",
          border: "1px solid var(--border)",
        }}
        onPointerMove={handleMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {Array.from({ length: Math.ceil(xMax) + 1 }, (_, i) => (
          <line
            key={`vx-${i}`}
            x1={(i / xMax) * W}
            x2={(i / xMax) * W}
            y1={0}
            y2={H}
            stroke="var(--rule)"
            strokeWidth={1}
          />
        ))}
        {Array.from({ length: Math.ceil(zMax) + 1 }, (_, i) => (
          <line
            key={`vy-${i}`}
            y1={(i / zMax) * H}
            y2={(i / zMax) * H}
            x1={0}
            x2={W}
            stroke="var(--rule)"
            strokeWidth={1}
          />
        ))}
        {tx && (
          <g onPointerDown={() => setDrag("tx")}>
            <rect
              x={tx.sx - 8}
              y={tx.sy - 8}
              width={16}
              height={16}
              fill="var(--accent)"
              stroke="var(--accent-bright)"
              strokeWidth={1}
              style={{ cursor: "grab" }}
            />
            <text x={tx.sx + 14} y={tx.sy + 4} fill="var(--accent-bright)" fontSize={11} fontFamily="var(--font-mono)">
              TX
            </text>
          </g>
        )}
        {rx && (
          <g onPointerDown={() => setDrag("rx")}>
            <rect
              x={rx.sx - 8}
              y={rx.sy - 8}
              width={16}
              height={16}
              fill="var(--status-info)"
              stroke="var(--status-info)"
              strokeWidth={1}
              style={{ cursor: "grab" }}
            />
            <text x={rx.sx + 14} y={rx.sy + 4} fill="var(--status-info)" fontSize={11} fontFamily="var(--font-mono)">
              RX
            </text>
          </g>
        )}
        {tx && rx && (
          <line x1={tx.sx} y1={tx.sy} x2={rx.sx} y2={rx.sy} stroke="var(--border-strong)" strokeDasharray="4 4" />
        )}
        {sub && (
          <g onPointerDown={() => setDrag("subject")}>
            <rect
              x={sub.sx - 12}
              y={sub.sy - 12}
              width={24}
              height={24}
              fill="var(--purple-glow)"
              fillOpacity={0.45}
              stroke="var(--purple-glow)"
              strokeWidth={1}
              style={{ cursor: "grab" }}
            />
            <text x={sub.sx + 18} y={sub.sy + 4} fill="var(--purple-glow)" fontSize={11} fontFamily="var(--font-mono)">
              subject
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  step?: number;
  min?: number;
}) {
  const [text, setText] = useState<string>(value == null ? "" : String(value));
  useEffect(() => {
    setText(value == null ? "" : String(value));
  }, [value]);
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.08em",
        color: "var(--text-faint)",
        textTransform: "uppercase",
      }}
    >
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={text}
        placeholder="—"
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw === "") onChange(null);
          else {
            const n = Number(raw);
            if (Number.isFinite(n)) onChange(n);
          }
        }}
        style={{
          width: 80,
          padding: "4px 6px",
          background: "var(--bg-deep)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          textTransform: "none",
        }}
      />
    </label>
  );
}

function tripleOrNull(triple: [number | null, number | null, number | null]): [number, number, number] | null {
  return triple.every((v) => v != null && Number.isFinite(v as number))
    ? (triple as [number, number, number])
    : null;
}

function GeometryPanel() {
  const [serverGeometry, setServerGeometry] = useState<RoomGeometry | null>(null);
  const [draftRoom, setDraftRoom] = useState<[number | null, number | null, number | null]>([null, null, null]);
  const [draftTx, setDraftTx] = useState<[number | null, number | null, number | null]>([null, null, null]);
  const [draftRx, setDraftRx] = useState<[number | null, number | null, number | null]>([null, null, null]);
  const [draftSubject, setDraftSubject] = useState<[number | null, number | null, number | null]>([null, null, null]);
  const [draftTxYaw, setDraftTxYaw] = useState<number>(0);
  const [draftRxYaw, setDraftRxYaw] = useState<number>(0);
  const [draftSubjectRadius, setDraftSubjectRadius] = useState<number>(0.35);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const g = await getRoomGeometry();
        if (alive) {
          setServerGeometry(g);
          if (g.room_extent_m) setDraftRoom([g.room_extent_m[0], g.room_extent_m[1], g.room_extent_m[2]]);
          if (g.tx_position_m) setDraftTx([g.tx_position_m[0], g.tx_position_m[1], g.tx_position_m[2]]);
          if (g.rx_position_m) setDraftRx([g.rx_position_m[0], g.rx_position_m[1], g.rx_position_m[2]]);
          if (g.subject_position_m)
            setDraftSubject([g.subject_position_m[0], g.subject_position_m[1], g.subject_position_m[2]]);
          setDraftTxYaw(g.tx_orientation_deg);
          setDraftRxYaw(g.rx_orientation_deg);
          setDraftSubjectRadius(g.subject_radius_m);
        }
      } catch (err) {
        if (alive) setError(String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const draftRoomT = tripleOrNull(draftRoom);
  const draftTxT = tripleOrNull(draftTx);
  const draftRxT = tripleOrNull(draftRx);
  const draftSubjectT = tripleOrNull(draftSubject);

  const operatorDistance = useMemo(() => {
    if (!draftTxT || !draftRxT) return null;
    const dx = draftTxT[0] - draftRxT[0];
    const dy = draftTxT[1] - draftRxT[1];
    const dz = draftTxT[2] - draftRxT[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }, [draftTxT, draftRxT]);

  const rssiImplied = serverGeometry?.rssi_implied_distance_m ?? null;
  const distanceDisagreement = useMemo(() => {
    if (operatorDistance == null || rssiImplied == null || operatorDistance < 0.1) return null;
    return rssiImplied / operatorDistance;
  }, [operatorDistance, rssiImplied]);

  if (serverGeometry == null && error == null) {
    return <Panel title="GEOMETRY">Loading…</Panel>;
  }

  const isComplete = draftRoomT != null && draftTxT != null && draftRxT != null;

  const save = async () => {
    if (!isComplete) return;
    try {
      const payload: RoomGeometry = {
        schema_version: "room_geometry.v1",
        room_extent_m: draftRoomT,
        tx_position_m: draftTxT,
        rx_position_m: draftRxT,
        tx_orientation_deg: draftTxYaw,
        rx_orientation_deg: draftRxYaw,
        subject_position_m: draftSubjectT,
        subject_radius_m: draftSubjectRadius,
        notes: serverGeometry?.notes ?? null,
        updated_ns: 0,
      };
      const saved = await putRoomGeometry(payload);
      setServerGeometry(saved);
      setSavedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Panel
      title="ROOM GEOMETRY"
      hint={`[Operator-supplied] · TX↔RX entered = ${
        operatorDistance != null ? `${operatorDistance.toFixed(2)} m` : "—"
      } · RSSI-implied ≈ ${
        rssiImplied != null ? `${rssiImplied.toFixed(2)} m (rough)` : "no frames yet"
      }`}
    >
      {error && <div className="banner danger">{error}</div>}
      {serverGeometry && !serverGeometry.is_complete && (
        <div className="banner warn">
          Geometry not saved yet. The 3D view will show a setup prompt until room + TX + RX are entered and saved.
        </div>
      )}
      {distanceDisagreement != null && (distanceDisagreement > 2 || distanceDisagreement < 0.5) && (
        <div className="banner danger">
          Operator-entered TX↔RX ({operatorDistance?.toFixed(2)} m) and RSSI-implied distance (
          {rssiImplied?.toFixed(2)} m) disagree by ≥2×. Either re-measure with a tape, or accept that
          indoor multipath is moving the RSSI estimate around (typical, not a bug).
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 24, alignItems: "start" }}>
        <Floorplan
          geometry={serverGeometry!}
          draftRoom={draftRoomT}
          draftTx={draftTxT}
          draftRx={draftRxT}
          draftSubject={draftSubjectT}
          onMoveTx={(xz) => setDraftTx([xz[0], draftTx[1] ?? 1.0, xz[1]])}
          onMoveRx={(xz) => setDraftRx([xz[0], draftRx[1] ?? 1.0, xz[1]])}
          onMoveSubject={(xz) => setDraftSubject([xz[0], draftSubject[1] ?? 1.0, xz[1]])}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <fieldset
            style={{
              border: "1px solid var(--border)",
              padding: 10,
              background: "var(--bg)",
            }}
          >
            <legend
              style={{
                padding: "0 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.12em",
                color: "var(--text-muted)",
                textTransform: "uppercase",
              }}
            >
              Room (metres) — required
            </legend>
            <div style={{ display: "flex", gap: 12 }}>
              <NumberField label="x (W)" value={draftRoom[0]} onChange={(v) => setDraftRoom([v, draftRoom[1], draftRoom[2]])} min={0} />
              <NumberField label="y (H)" value={draftRoom[1]} onChange={(v) => setDraftRoom([draftRoom[0], v, draftRoom[2]])} min={0} />
              <NumberField label="z (D)" value={draftRoom[2]} onChange={(v) => setDraftRoom([draftRoom[0], draftRoom[1], v])} min={0} />
            </div>
          </fieldset>
          <fieldset
            style={{
              border: "1px solid var(--border)",
              padding: 10,
              background: "var(--bg)",
            }}
          >
            <legend
              style={{
                padding: "0 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.12em",
                color: "var(--accent-bright)",
                textTransform: "uppercase",
              }}
            >
              TX — required
            </legend>
            <div style={{ display: "flex", gap: 12 }}>
              <NumberField label="x" value={draftTx[0]} onChange={(v) => setDraftTx([v, draftTx[1], draftTx[2]])} />
              <NumberField label="y" value={draftTx[1]} onChange={(v) => setDraftTx([draftTx[0], v, draftTx[2]])} />
              <NumberField label="z" value={draftTx[2]} onChange={(v) => setDraftTx([draftTx[0], draftTx[1], v])} />
              <NumberField label="yaw°" value={draftTxYaw} onChange={(v) => setDraftTxYaw(v ?? 0)} step={1} />
            </div>
          </fieldset>
          <fieldset
            style={{
              border: "1px solid var(--border)",
              padding: 10,
              background: "var(--bg)",
            }}
          >
            <legend
              style={{
                padding: "0 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.12em",
                color: "var(--status-info)",
                textTransform: "uppercase",
              }}
            >
              RX — required
            </legend>
            <div style={{ display: "flex", gap: 12 }}>
              <NumberField label="x" value={draftRx[0]} onChange={(v) => setDraftRx([v, draftRx[1], draftRx[2]])} />
              <NumberField label="y" value={draftRx[1]} onChange={(v) => setDraftRx([draftRx[0], v, draftRx[2]])} />
              <NumberField label="z" value={draftRx[2]} onChange={(v) => setDraftRx([draftRx[0], draftRx[1], v])} />
              <NumberField label="yaw°" value={draftRxYaw} onChange={(v) => setDraftRxYaw(v ?? 0)} step={1} />
            </div>
          </fieldset>
          <fieldset
            style={{
              border: "1px solid var(--border)",
              padding: 10,
              background: "var(--bg)",
            }}
          >
            <legend
              style={{
                padding: "0 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.12em",
                color: "var(--purple-glow)",
                textTransform: "uppercase",
              }}
            >
              Subject — optional
            </legend>
            <div style={{ display: "flex", gap: 12 }}>
              <NumberField label="x" value={draftSubject[0]} onChange={(v) => setDraftSubject([v, draftSubject[1], draftSubject[2]])} />
              <NumberField label="y" value={draftSubject[1]} onChange={(v) => setDraftSubject([draftSubject[0], v, draftSubject[2]])} />
              <NumberField label="z" value={draftSubject[2]} onChange={(v) => setDraftSubject([draftSubject[0], draftSubject[1], v])} />
              <NumberField label="radius" value={draftSubjectRadius} onChange={(v) => setDraftSubjectRadius(v ?? 0.35)} step={0.05} min={0.05} />
            </div>
          </fieldset>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={save} disabled={!isComplete} className="btn btn-primary" type="button">
              Save geometry
            </button>
            {!isComplete && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Fill room + TX + RX to enable.
              </span>
            )}
            {savedAt && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-faint)" }}>
                saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
            All values here are <strong>operator-entered</strong>. Nothing on this page is sensed
            except the link state above and the RSSI-implied distance, which is a rough indoor model
            and not a measurement.
          </div>
        </div>
      </div>
    </Panel>
  );
}

export default function DevicesV2Page() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <LinkPanel />
      <GeometryPanel />
    </div>
  );
}
