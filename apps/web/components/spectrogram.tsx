"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { DerivedWindow } from "../lib/types";
import { EmptyState } from "./empty-state";

/**
 * Time-subcarrier responsiveness map.
 *
 * Each row is a subcarrier (vertical), each column is one window in time
 * (horizontal), cell intensity is the per-subcarrier amplitude std for
 * that window.
 *
 * Renders to a single <canvas> via direct ImageData manipulation. The
 * previous DOM-grid implementation emitted one <span> per cell — at
 * 60 columns × ~64 rows = ~3840 React-managed DOM nodes per WS message,
 * which dominated the render cost on every derived window.
 */
function SubcarrierTimeMapImpl({
  windows,
  height = 200
}: {
  windows: DerivedWindow[];
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keep the matrix calculation memoized so we don't redo work when the
  // parent re-renders without new data.
  const cells = useMemo(() => {
    const recent = windows.slice(-60);
    if (recent.length === 0) return null;
    const width = Math.min(...recent.map((w) => w.amplitude_std.length || 0));
    if (!width) return null;
    let max = 1e-9;
    // Matrix is laid out [subcarrier_row * cols + col_t] for tight memory.
    const matrix = new Float32Array(width * recent.length);
    for (let s = 0; s < width; s += 1) {
      for (let t = 0; t < recent.length; t += 1) {
        const value = recent[t].amplitude_std[s] ?? 0;
        if (value > max) max = value;
        matrix[s * recent.length + t] = value;
      }
    }
    return { matrix, max, columns: recent.length, rows: width };
  }, [windows]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !cells) return;
    const { matrix, max, columns, rows } = cells;

    // Render at native cell resolution (1 px per cell), then let CSS scale.
    // ImageData write per WS message is ~7 KB of pixels — much cheaper than
    // any DOM-based path.
    canvas.width = columns;
    canvas.height = rows;
    canvas.style.width = "100%";
    canvas.style.height = `${height}px`;
    canvas.style.imageRendering = "pixelated";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(columns, rows);
    for (let s = 0; s < rows; s += 1) {
      for (let t = 0; t < columns; t += 1) {
        const value = matrix[s * columns + t];
        const ratio = Math.min(1, Math.max(0, value / max));
        // Same colour gradient as the old DOM version: cyan -> orange.
        // Hue 200 (cyan) at low energy -> 140 (orange/red shift) at high.
        const hue = 200 - ratio * 60;
        const lightness = 8 + ratio * 50;
        const [r, g, b] = hslToRgb(hue / 360, 0.8, lightness / 100);
        const idx = (s * columns + t) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [cells, height]);

  if (!cells) {
    return (
      <EmptyState
        title="No spectrogram data"
        message="The time-subcarrier map appears once derived windows are arriving."
      />
    );
  }

  return (
    <div ref={containerRef} className="spectrogram" style={{ height }} aria-label="Subcarrier responsiveness over time">
      <canvas ref={canvasRef} />
    </div>
  );
}

export const SubcarrierTimeMap = memo(SubcarrierTimeMapImpl, (prev, next) => {
  if (prev.height !== next.height) return false;
  if (prev.windows.length !== next.windows.length) return false;
  if (prev.windows.length === 0) return true;
  const a = prev.windows[prev.windows.length - 1];
  const b = next.windows[next.windows.length - 1];
  return a?.window_end_ns === b?.window_end_ns;
});

// HSL -> RGB. Standard formula. Returns 0-255 ints.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h + 1 / 3);
  const g = hueToRgb(p, q, h);
  const b = hueToRgb(p, q, h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
