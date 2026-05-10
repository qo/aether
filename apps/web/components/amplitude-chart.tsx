"use client";

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { memo, useEffect, useRef } from "react";
import type { DerivedWindow } from "../lib/types";
import { EmptyState } from "./empty-state";

const SERIES_DEF = [
  { label: "0-7", stroke: "#14B8A6", start: 0 },
  { label: "8-15", stroke: "#3B82F6", start: 8 },
  { label: "16-23", stroke: "#22C55E", start: 16 },
  { label: "24-31", stroke: "#F59E0B", start: 24 },
  { label: "32-39", stroke: "#8B91A8", start: 32 }
] as const;

/*
 * Subcarrier-group amplitude chart. Same incremental update pattern as
 * TrendChart — uPlot built once, fed via setData on every window arrival.
 */
function AmplitudeChartImpl({ windows }: { windows: DerivedWindow[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    const opts: uPlot.Options = {
      width: host.clientWidth || 720,
      height: 220,
      legend: { show: true, live: true },
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        ...SERIES_DEF.map<uPlot.Series>((s) => ({
          label: s.label,
          stroke: s.stroke,
          width: 1.5,
          spanGaps: true,
          points: { show: false }
        }))
      ],
      axes: [{ stroke: "#8B91A8" }, { stroke: "#8B91A8" }]
    };
    const chart = new uPlot(opts, [[], ...SERIES_DEF.map(() => [])] as unknown as uPlot.AlignedData, host);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !windows.length) return;
    const rows = windows.slice(-80);
    const x = rows.map((row) => row.window_end_ns / 1_000_000_000);
    const cols = SERIES_DEF.map((s) =>
      rows.map((row) => mean(row.amplitude_mean.slice(s.start, s.start + 8)))
    );
    chart.setData([x, ...cols] as unknown as uPlot.AlignedData);
  }, [windows]);

  if (!windows.length) {
    return <EmptyState title="No amplitude data" message="Amplitude traces appear after live or replay windows arrive." />;
  }

  return <div className="uplotHost" ref={hostRef} aria-label="Per-subcarrier group amplitude chart" />;
}

export const AmplitudeChart = memo(AmplitudeChartImpl, (prev, next) => {
  if (prev.windows.length !== next.windows.length) return false;
  if (prev.windows.length === 0) return true;
  const a = prev.windows[prev.windows.length - 1];
  const b = next.windows[next.windows.length - 1];
  return a?.window_end_ns === b?.window_end_ns;
});

function mean(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
