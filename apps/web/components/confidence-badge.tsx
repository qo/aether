export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  return <span className={`confidenceBadge ${level.toLowerCase()}`}>{level}</span>;
}
