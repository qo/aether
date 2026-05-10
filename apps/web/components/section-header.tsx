import type { ReactNode } from "react";

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="sectionHeader">
      <span>{title}</span>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
