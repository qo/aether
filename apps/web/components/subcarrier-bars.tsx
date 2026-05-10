"use client";

import { memo, useMemo } from "react";
import type { DerivedWindow } from "../lib/types";
import { EmptyState } from "./empty-state";

function SubcarrierBarsImpl({
  windows,
  metric = "amplitude_std",
  height = 96
}: {
  windows: DerivedWindow[];
  metric?: "amplitude_std" | "amplitude_mean";
  height?: number;
}) {
  const aggregate = useMemo(() => {
    const recent = windows.slice(-30);
    if (!recent.length) return null;
    const width = Math.min(...recent.map((w) => w[metric].length || 0));
    if (!width) return null;
    const sums = new Array<number>(width).fill(0);
    for (const w of recent) {
      for (let i = 0; i < width; i += 1) {
        sums[i] += w[metric][i] ?? 0;
      }
    }
    const values = sums.map((s) => s / recent.length);
    const max = Math.max(...values, 1e-9);
    return { values, max };
  }, [windows, metric]);

  if (!aggregate) {
    return <EmptyState title="No subcarrier data" message="Per-subcarrier responsiveness appears after CSI windows arrive." />;
  }

  return (
    <div className="subcarrierBars" style={{ height }} aria-label="Per-subcarrier responsiveness">
      {aggregate.values.map((value, idx) => {
        const ratio = value / aggregate.max;
        return (
          <span
            key={idx}
            className="subcarrierBar"
            style={{
              height: `${Math.max(2, Math.round(ratio * 100))}%`,
              background: `linear-gradient(180deg, hsl(${Math.round(190 - ratio * 60)} 70% 55%) 0%, hsl(${Math.round(
                190 - ratio * 60
              )} 70% 35%) 100%)`
            }}
            title={`subcarrier ${idx}: ${value.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}

export const SubcarrierBars = memo(SubcarrierBarsImpl, (prev, next) => {
  if (prev.height !== next.height || prev.metric !== next.metric) return false;
  if (prev.windows.length !== next.windows.length) return false;
  if (prev.windows.length === 0) return true;
  const a = prev.windows[prev.windows.length - 1];
  const b = next.windows[next.windows.length - 1];
  return a?.window_end_ns === b?.window_end_ns;
});
