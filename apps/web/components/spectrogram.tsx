"use client";

import { useMemo } from "react";
import type { DerivedWindow } from "../lib/types";
import { EmptyState } from "./empty-state";

/**
 * Time-subcarrier responsiveness map. Each row is a subcarrier (vertical
 * axis), each column is one window in time (horizontal axis), and the cell
 * intensity is the per-subcarrier amplitude std for that window.
 *
 * It is not a full STFT - we'd need raw frame access to compute one in the
 * browser - but it directly visualises which subcarriers are being perturbed
 * over time. For a person breathing in the link, you should see a few
 * adjacent rows lighting up rhythmically.
 */
export function SubcarrierTimeMap({
  windows,
  height = 200
}: {
  windows: DerivedWindow[];
  height?: number;
}) {
  const cells = useMemo(() => {
    const recent = windows.slice(-60);
    if (recent.length === 0) return null;
    const width = Math.min(...recent.map((w) => w.amplitude_std.length || 0));
    if (!width) return null;
    let max = 1e-9;
    const matrix: number[][] = [];
    for (let s = 0; s < width; s += 1) {
      const row: number[] = [];
      for (const w of recent) {
        const value = w.amplitude_std[s] ?? 0;
        if (value > max) max = value;
        row.push(value);
      }
      matrix.push(row);
    }
    return { matrix, max, columns: recent.length, rows: width };
  }, [windows]);

  if (!cells) {
    return (
      <EmptyState
        title="No spectrogram data"
        message="The time-subcarrier map appears once derived windows are arriving."
      />
    );
  }

  const { matrix, max, columns, rows } = cells;

  return (
    <div
      className="spectrogram"
      style={{
        height,
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }}
      aria-label="Subcarrier responsiveness over time"
    >
      {matrix.map((row, sIdx) =>
        row.map((value, tIdx) => {
          const ratio = Math.min(1, Math.max(0, value / max));
          const lightness = 8 + ratio * 50;
          const hue = 200 - ratio * 60; // cyan -> orange as energy rises
          return (
            <span
              key={`${sIdx}-${tIdx}`}
              className="spectrogramCell"
              style={{
                gridColumn: tIdx + 1,
                gridRow: sIdx + 1,
                background: `hsl(${hue} 80% ${lightness}%)`
              }}
              title={`subcarrier ${sIdx}, t-${columns - tIdx} window: ${value.toFixed(2)}`}
            />
          );
        })
      )}
    </div>
  );
}
