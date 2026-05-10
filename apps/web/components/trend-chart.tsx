"use client";

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { memo, useEffect, useMemo, useRef } from "react";
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

/*
 * Incremental uPlot trend chart.
 *
 * The previous implementation destroyed and recreated the entire uPlot
 * instance on every windows change — i.e. ~20 times/sec at full WS
 * cadence. uPlot has a `setData()` path that updates the series in place
 * with a single canvas redraw. We use that for steady-state updates and
 * only rebuild when the *shape* of the chart changes (number of series,
 * height, scales).
 */
function TrendChartImpl({
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
  const seriesRef = useRef<TrendSeries[]>(series);
  seriesRef.current = series;

  // Stable signature for the chart's "shape" — when this changes we tear
  // down + rebuild. When only `windows` changes we hit the setData fast path.
  const shapeKey = useMemo(() => {
    return [
      height,
      series.length,
      ...series.map((s) => `${s.label}|${s.stroke}|${s.scale ?? "y"}|${s.dash?.join(",") ?? ""}|${s.width ?? ""}`)
    ].join("::");
  }, [height, series]);

  // (Re)build the chart only when the shape changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
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
    // Seed with empty data; the setData effect below populates it.
    const chart = new uPlot(opts, [[], ...series.map(() => [])] as unknown as uPlot.AlignedData, host);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, [shapeKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Fast path: when only data changes, push it via setData. No DOM teardown,
  // no canvas reattach — uPlot redraws in-place.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !windows.length) return;
    const last = windows.slice(-120);
    const x = last.map((w) => w.window_end_ns / 1_000_000_000);
    const cols = seriesRef.current.map((s) =>
      last.map((w) => {
        const v = s.pick(w);
        return v == null || !Number.isFinite(v) ? null : v;
      })
    );
    chart.setData([x, ...cols] as unknown as uPlot.AlignedData);
  }, [windows]);

  if (!windows.length) {
    return <EmptyState title="No trend data" message="Trends populate as derived windows arrive." />;
  }

  return <div className="uplotHost" ref={hostRef} aria-label={ariaLabel ?? "Trend chart"} />;
}

export const TrendChart = memo(TrendChartImpl, (prev, next) => {
  // Re-render only when:
  //  - height changed
  //  - series shape changed (different list)
  //  - the latest window changed (length or last window's end timestamp)
  if (prev.height !== next.height) return false;
  if (prev.series.length !== next.series.length) return false;
  for (let i = 0; i < prev.series.length; i += 1) {
    if (prev.series[i] !== next.series[i]) return false;
  }
  if (prev.windows.length !== next.windows.length) return false;
  if (prev.windows.length === 0) return true;
  const a = prev.windows[prev.windows.length - 1];
  const b = next.windows[next.windows.length - 1];
  return a?.window_end_ns === b?.window_end_ns;
});
