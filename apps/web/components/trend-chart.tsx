"use client";

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useEffect, useRef } from "react";
import type { DerivedWindow } from "../lib/types";
import { EmptyState } from "./empty-state";

export interface TrendSeries {
  label: string;
  stroke: string;
  pick: (window: DerivedWindow) => number | null | undefined;
  scale?: string;
  width?: number;
  dash?: number[];
}

export function TrendChart({
  windows,
  series,
  height = 240,
  ariaLabel
}: {
  windows: DerivedWindow[];
  series: TrendSeries[];
  height?: number;
  ariaLabel?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !windows.length) return;
    host.innerHTML = "";
    const last = windows.slice(-120);
    const x = last.map((w) => w.window_end_ns / 1_000_000_000);
    const cols = series.map((s) =>
      last.map((w) => {
        const v = s.pick(w);
        return v == null || !Number.isFinite(v) ? null : v;
      })
    );
    const usedScales = new Set(series.map((s) => s.scale ?? "y"));
    const axes: uPlot.Axis[] = [
      { stroke: "#8B91A8" },
      { stroke: "#8B91A8", scale: "y", grid: { stroke: "#2a2f3e" } }
    ];
    if (usedScales.has("bpm")) {
      axes.push({ stroke: "#F59E0B", scale: "bpm", side: 1, grid: { show: false } });
    }
    const opts: uPlot.Options = {
      width: host.clientWidth || 720,
      height,
      legend: { show: true, live: true },
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { time: true },
        y: { auto: true },
        ...(usedScales.has("bpm") ? { bpm: { auto: true } } : {})
      },
      axes,
      series: [
        {},
        ...series.map<uPlot.Series>((s) => ({
          label: s.label,
          stroke: s.stroke,
          width: s.width ?? 1.5,
          dash: s.dash,
          scale: s.scale ?? "y",
          spanGaps: true,
          points: { show: false }
        }))
      ]
    };
    const chart = new uPlot(opts, [x, ...cols] as unknown as uPlot.AlignedData, host);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, [windows, series, height]);

  if (!windows.length) {
    return <EmptyState title="No trend data" message="Trends populate as derived windows arrive." />;
  }

  return <div className="uplotHost" ref={hostRef} aria-label={ariaLabel ?? "Trend chart"} />;
}
