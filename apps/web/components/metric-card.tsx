import type { ReactNode } from "react";
import { ConfidenceBadge } from "./confidence-badge";
import { Sparkline } from "./sparkline";

export function MetricCard({
  title,
  value,
  unit,
  detail,
  confidence,
  sparkline,
  icon
}: {
  title: string;
  value: string | number | null;
  unit?: string;
  detail?: string;
  confidence?: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  sparkline?: number[];
  icon?: ReactNode;
}) {
  return (
    <section className="metricCard">
      <div className="metricLabel">
        {icon}
        <span>{title}</span>
      </div>
      <div className="metricValue">
        <strong>{value ?? "--"}</strong>
        {unit ? <span>{unit}</span> : null}
      </div>
      {sparkline?.length ? <Sparkline values={sparkline} /> : null}
      {confidence ? <ConfidenceBadge level={confidence} /> : null}
      {detail ? <small>{detail}</small> : null}
    </section>
  );
}
