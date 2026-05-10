# Aether UI design system

Single source of truth for the look-and-feel of the Aether console. Anything
visual added to `apps/web` should pull from these tokens — do not invent new
hexes, radii, or shadows. Tokens live in `apps/web/app/globals.css` as CSS
custom properties.

## Voice

Flat, strong, enterprise. Local-first instrument software, not a SaaS dashboard.

Hard rules:

- **No rounded corners.** Anywhere. `*, *::before, *::after { border-radius: 0 !important }` is enforced globally.
- **No drop shadows, no glow, no backdrop blur, no gradients.** "Elevation" is
  expressed by a stronger 1 px border or a slightly lighter panel surface, never
  by a shadow.
- **Monospace for numbers, sans for labels.** Inter for UI; JetBrains Mono for
  any quantity, identifier, timestamp, or path.
- **Borders are 1 px.** Two-pixel borders read as bold; reserve them for left
  rails on the active nav item.
- **Live data is the only thing that gets the bright pulse-green** (`--accent-bright`).
  Static UI uses the muted forest-green `--accent`.

## Palette

The console runs on one near-black background with a deep-purple undertone, one
forest-green primary, and one bright pulse-green reserved for sensed live data.

### Surfaces (deepest first)

| Token            | Hex       | Use                                                  |
| ---------------- | --------- | ---------------------------------------------------- |
| `--bg-deep`      | `#03040a` | Page background; near-black with purple undertone    |
| `--bg`           | `#06070d` | Default workspace background                         |
| `--panel`        | `#0a0d12` | Card / panel face                                    |
| `--panel-elev`   | `#0e1218` | Panel that needs to read above another panel         |
| `--sidebar`      | `#04050a` | Sidebar surface, slightly deeper than `--bg`         |
| `--topbar`       | `#06070d` | Global topbar background                             |
| `--hud`          | `#050610` | HUD overlays in the 3D view                          |

### Borders / strokes

| Token              | Hex       | Use                                            |
| ------------------ | --------- | ---------------------------------------------- |
| `--border`         | `#15211a` | Subtle green border, default                   |
| `--border-strong`  | `#1f3527` | Strong border for active / focused states      |
| `--border-purple`  | `#1a1230` | Deep purple accent border, used sparingly      |
| `--rule`           | `#0e1614` | Hairline rule between sections / grid lines    |

### Text

| Token             | Hex       | Use                                              |
| ----------------- | --------- | ------------------------------------------------ |
| `--text`          | `#c8d4c4` | Primary readable                                 |
| `--text-strong`   | `#e6efe1` | Stronger contrast for headings and numbers       |
| `--text-muted`    | `#6c7c68` | Secondary text                                   |
| `--text-faint`    | `#3a4438` | Labels, hints, axis ticks                        |
| `--text-on-accent`| `#03130a` | Text laid on a green accent fill                 |

### Accents

| Token             | Hex       | Use                                                              |
| ----------------- | --------- | ---------------------------------------------------------------- |
| `--accent`        | `#1f7a3a` | Primary forest green — buttons, focus rings, links, active rail  |
| `--accent-hover`  | `#25923f` | Hovered primary accent                                           |
| `--accent-bright` | `#4ee68a` | Live pulse-green — **sensed live data only**                     |
| `--purple-deep`   | `#1c0a2e` | Deep purple, sparing accent (background of selected detail rows) |
| `--purple-glow`   | `#2c1448` | Slightly lighter purple, also sparing                            |

### Status semantics

| Token            | Hex       | Use                                            |
| ---------------- | --------- | ---------------------------------------------- |
| `--status-good`  | `#4ee68a` | OK / streaming / pass                          |
| `--status-warn`  | `#d4a44e` | Degraded / approximate / not-yet-stable        |
| `--status-danger`| `#d05a4e` | Failed / unreachable / hard error              |
| `--status-info`  | `#4ea0d0` | Informational, e.g. RX antenna marker          |
| `--status-muted` | `#485248` | Indeterminate / no data yet                    |

The colour-blind safety here is weak (greens dominate). When status colour
matters for compliance, pair the colour with text or a glyph.

## Typography

```
--font-sans:  Inter, ui-sans-serif, system-ui, sans-serif
--font-mono:  JetBrains Mono, ui-monospace, monospace
```

- 13 px body, 11 px labels in monospace, 10 px micro-labels in monospace.
- Labels are uppercase with `letter-spacing: 0.08em–0.16em`.
- Numbers use `font-feature-settings: "zero", "ss01"` for unambiguous zero and
  consistent spacing.

## Geometry

```
--radius:     0
--hairline:   1px solid var(--border)
--sidebar-w:  220px
--topbar-h:  44px
```

The shell is a 220 px sidebar on the left, a 44 px topbar across the right
column, and content beneath. Embed mode (`?embed=1`) drops the shell entirely
so the 3D view can pop out into a clean window.

## Component classes

The shell and component classes live in `apps/web/app/globals.css`. Pages
should compose these instead of writing inline styles.

- `.shell`, `.shell-sidebar`, `.shell-topbar`, `.shell-content` — outer chrome.
- `.shell-nav-section`, `.shell-nav-item` (`.is-active`), `.shell-nav-label` — sidebar nav.
- `.panel`, `.panel-header`, `.panel-body` — bordered rectangles for content.
- `.stat-tile` (`.good`, `.warn`, `.danger`) — single-number display tile.
- `.banner` (`.warn`, `.danger`, `.info`) — inline alert inside a panel.
- `.btn`, `.btn-primary`, `.btn-danger` — buttons.
- `.kvList` — `<dl>` style key/value grid.
- `.statusDot` (`.success`, `.warning`, `.danger`, `.muted`, `.connecting`) — status pip.
- `.sourceBadge` (`.live`, `.replay`, `.disconnected`), `.confidenceBadge` — provenance pills.

## Source-mode honesty

Every screen surfaces the `source_mode` (`LIVE`, `REPLAY`, or none). Sensed
values are the only ones allowed to use `--accent-bright`. Operator-supplied
values (room geometry, subject position) and computed values (RSSI-implied
distance) use `--text` or `--text-muted` and carry an explicit `[Sensed]`,
`[Operator-supplied]`, or `[Computed]` tag in their panel header.

If a value is null (no frames yet, geometry not entered), render `—` rather
than a zero. Zero is a measurement; `—` is the absence of one.
