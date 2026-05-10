export type StatusTone = "success" | "warning" | "danger" | "muted" | "connecting";

export function StatusDot({ status = "muted", size = "sm" }: { status?: StatusTone; size?: "sm" | "md" }) {
  return <span className={`statusDot ${status} ${size}`} aria-hidden="true" />;
}
