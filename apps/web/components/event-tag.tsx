export function EventTag({ eventType }: { eventType: string }) {
  return <span className="eventTag">{eventType.replaceAll("_", " ")}</span>;
}
