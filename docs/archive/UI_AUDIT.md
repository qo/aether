# UI Audit

Purpose: document the current UI before replacing prototype presentation with an enterprise product interface.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] The UI is currently a single client component with tab-like buttons, seeded measurements, and decorative RF visuals.
- [Confirmed in code] No Storybook setup exists.
- [Unknown / needs verification] No browser screenshot artifact is checked into the repo.

## Current Structure

`apps/web/app/page.tsx` renders `RadioVisionConsole`.

`RadioVisionConsole` contains:

- Header with “Radio Vision V0” and `SourceBadge`.
- Button tabs for Live Room, Experiment Console, Data Explorer, Knowledge Base, Agent Console, and System / Devices.
- Local state for windows and room summary, initialized with fabricated values.
- WebSocket connection that appends real derived windows if present.

## Page Audit

### Live Room

- Renders seeded packet rate, RSSI, quality, occupancy, motion, event text, and a decorative RF field.
- `RfField` canvas uses fallback amplitude values when no window exists.
- Waterfall and trend components can render real windows, but the page initially feeds them fabricated seed data.
- Prototype issues: two-column layout only, oversized hero panel, vague “Channel field” hierarchy, decorative canvas, neon cyan, scanline background, pill badges.

### Experiment Console

- Renders a static protocol dropdown and label buttons.
- Buttons do not call real session/event APIs.
- Static form is acceptable as layout scaffolding but currently lacks real disabled/empty behavior.

### Data Explorer

- Renders current session from latest in-memory window only.
- Shows a JSON dump of latest window.
- No real session picker/table/report state despite API support for sessions and summaries.

### Knowledge Base

- Renders static “What We Know” bullets and a local input.
- No endpoint-backed search.
- Must become an honest empty/unavailable state unless an existing API is exposed.

### Agent Console

- Renders a canned question and answer from local summary props.
- No real agent API endpoint exists.
- Must become an unavailable state instead of canned agent content.

### System / Devices

- Renders local source-mode-derived text and static service bullets.
- `/health` and `/devices` exist and should be used instead.

## Decorative / Prototype Styling

- `apps/web/app/globals.css` uses near-black/cyan neon variables, scanline background, gradient card fills, large shadows, pill shapes, and cyan active states.
- `apps/web/components/rf-field.tsx` is decorative and must be removed.
- `apps/web/features/radio-vision-console.tsx` seeds fake data and therefore makes the product look connected when it is not.

## Layout Risks At 1280px+

- The top tab row consumes horizontal space and does not provide enterprise navigation structure.
- The Live Room uses a 2-column layout, not the specified 12-column monitoring dashboard.
- Data Explorer and Knowledge Base are shallow two-column panels with insufficient table/filter structure.
- Metric hierarchy is prototype-level and not dense enough for repeated operational use.

## Redesign Direction

Replace the UI with a fixed sidebar shell, a compact top bar, enterprise tokens, real/empty data states, real WebSocket-driven charts, and no decorative visuals that encode no measurement.
