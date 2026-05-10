"use client";

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useEffect, useRef } from "react";
import type { DerivedWindow } from "../lib/types";
import { EmptyState } from "./empty-state";

export function AmplitudeChart({ windows }: { windows: DerivedWindow[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !windows.length) return;
    host.innerHTML = "";
    const rows = windows.slice(-80);
    const x = rows.map((row) => row.window_end_ns / 1_000_000_000);
    const groups = [0, 8, 16, 24, 32].map((start) =>
      rows.map((row) => mean(row.amplitude_mean.slice(start, start + 8)))
    );
    const chart = new uPlot(
      {
        width: host.clientWidth || 720,
        height: 220,
        series: [
          {},
          { label: "0-7", stroke: "#14B8A6", width: 1.5 },
          { label: "8-15", stroke: "#3B82F6", width: 1.5 },
          { label: "16-23", stroke: "#22C55E", width: 1.5 },
          { label: "24-31", stroke: "#F59E0B", width: 1.5 },
          { label: "32-39", stroke: "#8B91A8", width: 1.5 }
        ],
        axes: [{ stroke: "#8B91A8" }, { stroke: "#8B91A8" }]
      },
      [x, ...groups],
      host
    );
    return () => chart.destroy();
  }, [windows]);

  if (!windows.length) {
    return <EmptyState title="No amplitude data" message="Amplitude traces appear after live or replay windows arrive." />;
  }

  return <div className="uplotHost" ref={hostRef} aria-label="Per-subcarrier group amplitude chart" />;
}

function mean(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
