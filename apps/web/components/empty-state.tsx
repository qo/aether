import type { ReactNode } from "react";

export function EmptyState({
  title,
  message,
  action
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="emptyState" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
      {action ? <div className="emptyAction">{action}</div> : null}
    </div>
  );
}
