import { ConfidenceBadge } from "../components/confidence-badge";
import { DisconnectedBanner } from "../components/disconnected-banner";
import { EmptyState } from "../components/empty-state";
import { EventTag } from "../components/event-tag";
import { MetricCard } from "../components/metric-card";
import { SourceBadge } from "../components/source-badge";
import { StatusDot } from "../components/status-dot";

export function ComponentFixture() {
  return (
    <main>
      <DisconnectedBanner status="connected" reason="no_serial_port" sourceMode="LIVE" />
      <StatusDot status="success" />
      <SourceBadge mode="LIVE" />
      <ConfidenceBadge level="UNKNOWN" />
      <EventTag eventType="cross_los" />
      <MetricCard title="Packet rate" value={null} unit="Hz" confidence="UNKNOWN" />
      <EmptyState title="No data" message="Connect hardware or replay a recorded session." />
    </main>
  );
}
