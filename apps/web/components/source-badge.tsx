import type { SourceMode } from "../lib/types";

export function SourceBadge({ mode, status }: { mode: SourceMode | null; status?: string }) {
  const label = mode ?? "DISCONNECTED";
  return (
    <div className={`sourceBadge ${label.toLowerCase()}`} aria-label={`Source ${label}`}>
      <span>{label}</span>
      {status ? <small>{status}</small> : null}
    </div>
  );
}
