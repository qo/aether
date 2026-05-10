# Data Model

Purpose: describe stored sessions, frames, derived windows, and labels.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Session metadata storage uses SQLite and raw recordings can be JSONL or Parquet-compatible records.
- [Unknown / needs verification] Parquet performance should be measured against long live sessions.

## Entities

- Session: UUID, source mode, protocol, notes, timestamps.
- Raw CSI frame: versioned `csi_frame.v1` record.
- Derived window: versioned `derived_window.v1` record.
- Experiment event: timestamped label from the experiment console.
- Report: generated Markdown/JSON summary for a session.

## Privacy Fields

Stored datasets must include consent/session metadata and avoid MAC-linked personal histories in V0.
