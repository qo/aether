"use client";

/**
 * 3D Wave View — operator-supplied geometry + sensed link telemetry.
 *
 * STRICT honesty contract:
 *   - Antenna positions: from saved geometry only. No defaults. If geometry
 *     is missing the parent route does NOT mount this component.
 *   - Subject blob: at the operator-supplied subject position (if any).
 *     Radius proportional to *real* occupancy_score; emissive intensity
 *     proportional to *real* motion_score. When motion is zero the blob
 *     does NOT wobble, breathe, or animate. It just sits there.
 *   - Wave pulses: emitted once per actual raw_frame WS event, brightness
 *     scaled by the frame's actual RSSI. Visual propagation speed is
 *     deliberately slowed; the slowdown is labelled in the HUD. We do NOT
 *     synthesise pulses from observed Hz when raw frames aren't streaming —
 *     no raw_frame topic = no pulses, period.
 *   - Subcarrier carpet: vertex height = real amplitude_mean values.
 *     Endpoints anchored to operator-supplied TX / RX positions.
 *
 * What this component will NOT render under any circumstances:
 *   - A placeholder room.
 *   - "Multipath hint" rays (illustrative, not sensed — removed v0.3).
 *   - Synthesised pulses (removed v0.3).
 *   - Subject motion / pose / orientation (hardware can't sense them).
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Line, OrbitControls, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type {
  DerivedWindow,
  RawFrame,
  RoomGeometry,
} from "../../lib/types";

const LAYER_COLORS = {
  tx: "#34d399",
  rx: "#60a5fa",
  subject: "#f472b6",
  pulse: "#fde047",
  carpet: "#a78bfa",
};

interface SceneProps {
  /** Caller MUST supply a geometry whose room/tx/rx are non-null. */
  geometry: RoomGeometry & {
    room_extent_m: [number, number, number];
    tx_position_m: [number, number, number];
    rx_position_m: [number, number, number];
  };
  latestWindow: DerivedWindow | null;
  latestFrames: RawFrame[];
  layers: {
    pulses: boolean;
    carpet: boolean;
    subject: boolean;
    grid: boolean;
  };
  cameraPreset: CameraPreset;
}

export type CameraPreset = "birdseye" | "side" | "front" | "free";

/** A single pulse instance — one per real CSI packet. */
interface Pulse {
  born: number;     // performance.now ms
  rssi: number;
  ttl: number;
}

function Antenna({ pos, label, color }: { pos: [number, number, number]; label: string; color: string }) {
  return (
    <group position={pos}>
      <mesh>
        <boxGeometry args={[0.18, 0.32, 0.06]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </mesh>
      <Line
        points={[
          [0, 0, 0],
          [0, -pos[1], 0],
        ]}
        color={color}
        opacity={0.3}
        transparent
        lineWidth={1}
      />
      <Text
        position={[0, 0.32, 0]}
        fontSize={0.12}
        color={color}
        anchorX="center"
        anchorY="bottom"
      >
        {label}
      </Text>
    </group>
  );
}

function SubjectBlob({ pos, motion, occupancy, hasWindow }: {
  pos: [number, number, number];
  motion: number;
  occupancy: number;
  hasWindow: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  // Radius is fully driven by sensed occupancy; emissive by sensed motion.
  // No baseline wobble — when motion is zero the mesh holds still.
  useFrame(() => {
    if (!meshRef.current) return;
    const radius = 0.15 + occupancy * 0.5;
    meshRef.current.scale.setScalar(radius);
  });
  if (!hasWindow) {
    return null;
  }
  return (
    <group position={pos}>
      <mesh ref={meshRef}>
        <icosahedronGeometry args={[1, 2]} />
        <meshStandardMaterial
          color={LAYER_COLORS.subject}
          emissive={LAYER_COLORS.subject}
          emissiveIntensity={0.3 + Math.min(1.5, motion) * 0.7}
          transparent
          opacity={0.55}
        />
      </mesh>
      <Text
        position={[0, 0.7, 0]}
        fontSize={0.11}
        color={LAYER_COLORS.subject}
        anchorX="center"
      >
        subject (operator-placed)
      </Text>
      <Text
        position={[0, 0.55, 0]}
        fontSize={0.08}
        color="#cbd5e1"
        anchorX="center"
      >
        motion={motion.toFixed(2)} · occ={occupancy.toFixed(2)}
      </Text>
    </group>
  );
}

function PropagationField({
  txPos,
  pulses,
  visualSpeed,
}: {
  txPos: [number, number, number];
  pulses: Pulse[];
  visualSpeed: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const refsRef = useRef<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; born: number; rssi: number; ttl: number }[]>([]);

  useEffect(() => {
    refsRef.current = [];
  }, []);

  useFrame(() => {
    const now = performance.now();
    refsRef.current.forEach((entry) => {
      if (!entry.mesh) return;
      const age = (now - entry.born) / 1000;
      const r = age * visualSpeed;
      entry.mesh.scale.setScalar(r);
      const rssiLin = Math.max(0.2, Math.min(1.0, (entry.rssi + 90) / 80));
      const opacity = Math.max(0, rssiLin * (1 - age / entry.ttl));
      entry.mat.opacity = opacity;
    });
  });

  return (
    <group ref={groupRef} position={txPos}>
      {pulses.map((p, i) => (
        <PulseSphere
          key={`${p.born}-${i}`}
          rssi={p.rssi}
          ttl={p.ttl}
          born={p.born}
          onMount={(mesh, mat) => {
            refsRef.current.push({ mesh, mat, born: p.born, rssi: p.rssi, ttl: p.ttl });
          }}
          onUnmount={(mesh) => {
            refsRef.current = refsRef.current.filter((r) => r.mesh !== mesh);
          }}
        />
      ))}
    </group>
  );
}

function PulseSphere({
  rssi,
  onMount,
  onUnmount,
}: {
  rssi: number;
  ttl: number;
  born: number;
  onMount: (mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial) => void;
  onUnmount: (mesh: THREE.Mesh) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  useEffect(() => {
    if (meshRef.current && matRef.current) onMount(meshRef.current, matRef.current);
    return () => {
      if (meshRef.current) onUnmount(meshRef.current);
    };
  }, []);
  const hue = Math.max(40, 220 - (rssi + 90) * 2);
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 24, 16]} />
      <meshBasicMaterial
        ref={matRef}
        color={new THREE.Color(`hsl(${hue}, 90%, 60%)`)}
        wireframe
        transparent
        opacity={0.6}
      />
    </mesh>
  );
}

function SubcarrierCarpet({ txPos, rxPos, amplitudes }: {
  txPos: [number, number, number];
  rxPos: [number, number, number];
  amplitudes: number[];
}) {
  const tx = useMemo(() => new THREE.Vector3(...txPos), [txPos.join(",")]);
  const rx = useMemo(() => new THREE.Vector3(...rxPos), [rxPos.join(",")]);
  const n = amplitudes.length;
  const max = Math.max(1e-6, ...amplitudes);

  if (n < 2) return null;

  const points: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    const pos = new THREE.Vector3().lerpVectors(tx, rx, t);
    const h = (amplitudes[i] / max) * 0.5;
    points.push([pos.x, pos.y + h, pos.z]);
  }
  return (
    <group>
      <Line points={points} color={LAYER_COLORS.carpet} lineWidth={2} />
    </group>
  );
}

function CameraRig({ preset, target }: { preset: CameraPreset; target: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (preset === "free") return;
    const [tx, ty, tz] = target;
    const lookTarget = new THREE.Vector3(tx, ty, tz);
    let desired: THREE.Vector3;
    if (preset === "birdseye") desired = new THREE.Vector3(tx, ty + 6, tz + 0.001);
    else if (preset === "side") desired = new THREE.Vector3(tx + 6, ty, tz);
    else desired = new THREE.Vector3(tx, ty, tz + 6);
    camera.position.lerp(desired, 0.08);
    camera.lookAt(lookTarget);
  });
  return <group ref={ref} />;
}

export function ThreeDScene(props: SceneProps) {
  const { geometry, latestWindow, latestFrames, layers, cameraPreset } = props;
  const tx = geometry.tx_position_m;
  const rx = geometry.rx_position_m;
  const room = geometry.room_extent_m;
  const subject = geometry.subject_position_m;

  const [pulses, setPulses] = useState<Pulse[]>([]);
  const lastPulseTs = useRef<number>(0);

  // Spawn one pulse per newly-arrived raw frame. NO synthesis from observed
  // Hz — if no raw_frame topic is subscribed, no pulses appear.
  useEffect(() => {
    if (latestFrames.length === 0) return;
    const f = latestFrames[latestFrames.length - 1];
    if (f.ts_host_ns === lastPulseTs.current) return;
    lastPulseTs.current = f.ts_host_ns;
    setPulses((curr) => {
      const ttl = 3.0;
      const next = [...curr, { born: performance.now(), rssi: f.rssi_dbm, ttl }];
      const cleaned = next.filter((p) => (performance.now() - p.born) / 1000 < p.ttl);
      return cleaned.slice(-60);
    });
  }, [latestFrames]);

  const target: [number, number, number] = [room[0] / 2, room[1] / 2, room[2] / 2];

  return (
    <Canvas
      style={{ width: "100%", height: "100%", background: "#020617" }}
      camera={{ position: [room[0] * 0.7, room[1] * 1.5, room[2] * 1.5], fov: 55 }}
    >
      <CameraRig preset={cameraPreset} target={target} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[room[0], room[1] * 2, room[2]]} intensity={0.7} />
      <directionalLight position={[-room[0], room[1] * 2, -room[2]]} intensity={0.25} color="#a78bfa" />

      {layers.grid && (
        <Grid
          args={[room[0] * 1.5, room[2] * 1.5]}
          position={[room[0] / 2, 0, room[2] / 2]}
          cellSize={0.5}
          sectionSize={2}
          cellColor="#1f2937"
          sectionColor="#475569"
          fadeDistance={40}
          fadeStrength={1.5}
        />
      )}

      <Line
        points={[
          [0, 0, 0], [room[0], 0, 0], [room[0], 0, room[2]], [0, 0, room[2]], [0, 0, 0],
          [0, room[1], 0], [room[0], room[1], 0], [room[0], room[1], room[2]], [0, room[1], room[2]], [0, room[1], 0],
        ]}
        color="#1f2937"
        lineWidth={1}
      />

      <Antenna pos={tx} label="TX (operator)" color={LAYER_COLORS.tx} />
      <Antenna pos={rx} label="RX (operator)" color={LAYER_COLORS.rx} />

      {layers.subject && subject && (
        <SubjectBlob
          pos={subject}
          motion={latestWindow?.motion_score ?? 0}
          occupancy={latestWindow?.occupancy_score ?? 0}
          hasWindow={latestWindow != null}
        />
      )}

      {layers.carpet && latestWindow?.amplitude_mean && latestWindow.amplitude_mean.length > 1 && (
        <SubcarrierCarpet txPos={tx} rxPos={rx} amplitudes={latestWindow.amplitude_mean} />
      )}

      {layers.pulses && pulses.length > 0 && (
        <PropagationField txPos={tx} pulses={pulses} visualSpeed={2.0} />
      )}

      {cameraPreset === "free" && <OrbitControls makeDefault enablePan enableRotate />}
    </Canvas>
  );
}
