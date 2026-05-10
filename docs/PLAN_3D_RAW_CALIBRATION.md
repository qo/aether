# Plan — Calibration Hardening, Raw-Sensor Tab, 3D Wave View

Date: 2026-05-10. Status: **v0.2 implemented** — see "Implementation status" at
the foot of this doc for what shipped vs what's still on the roadmap.
Scope:
1. Audit: what's broken / inaccurate today and why.
2. Calibration plan to push the V0 numbers as close to "trustable" as the
   hardware allows.
3. Raw-Sensor side tab — schema, transport, UI.
4. UI reorganisation around a side-pinned diagnostic surface.
5. 3D pop-out wave / room view (research, library choices, scene graph).
6. End-to-end build order, gates, and test plan.

All claims labelled per `CLAUDE.md`: `[Confirmed in code]` / `[Confirmed in
docs]` / `[Inference]` / `[Unknown]`.

---

## 1. Issues found in the current code

Severity tags: **Blocker / Major / Minor / Cosmetic / Scaffolding**.

### 1.1 Hardware / link

| # | Issue | Where | Severity |
|---|---|---|---|
| 1 | Live packet rate is ~6 Hz, target ~20 Hz. Not instrumented end-to-end so the bottleneck (TX cadence vs. Wi-Fi link vs. `pyserial.readline()` vs. queue) is unknown. | `runtime.py:24`, `serial_reader.py`, `firmware/.../tx_config.h` | **Major** — every accuracy claim degrades linearly with this. |
| 2 | TX board's USB endpoint (COM9 on this box) cannot be opened — already documented in `PROBLEMS.md` 1.2; non-blocking. | `scripts/probe_serial.py` | Minor |
| 3 | RX CSI queue depth is 32 packets and overflow drops are silent. | `firmware/esp32-s3-rx/main/csi_capture.c:41` `[Confirmed in code]` | Major if 1.1 ever spikes; today we lose data without knowing. |

### 1.2 DSP — magic numbers and assumptions

All `[Confirmed in code]` references; line numbers from current `main`.

| # | Issue | Where |
|---|---|---|
| 4 | Edge-subcarrier drop is hardcoded **6 % each side** with no per-device probe. | `services/dsp/src/preprocessing.py:107`, `features.py:77` |
| 5 | Bandpass band hardcoded **0.05–5 Hz**; high edge clamped to `0.4·fs`. If `fs=6 Hz` (current reality) the high edge is 2.4 Hz — fine for breathing, but motion energy >2.4 Hz is silently lost. | `features.py:47, 106` |
| 6 | Uncalibrated occupancy is normalised by a **fixed 18 dB scale**; calibrated mode uses **4×baseline_std**. Both numbers are guesses. | `features.py:147, 149` |
| 7 | Motion thresholds 1.2 (calibrated) / 4.0 (uncalibrated) are guesses, not derived from empty-room runs. | `services/dsp/src/motion.py:11-12` |
| 8 | `expected_packet_rate_hz` is hardcoded to 20 Hz; quality score penalises everything below it permanently. If the link is genuinely 6 Hz, quality maxes out at ~0.6. | `runtime.py:24`, `features.py:162-165` |
| 9 | Hampel filter window is **7 frames** with no comment on why. At 20 Hz that's 350 ms; at 6 Hz it's 1.17 s — different statistical behaviour. | `features.py:82`, `filters.py:24-62` |
| 10 | Subcarrier selection runs independently in motion vs. biorhythm — no shared "responsive subcarrier" set, so motion uses noisy subcarriers the biorhythm path has already discarded. | `features.py` vs `biorhythm.py:248`, `calibration.py:158-178` |
| 11 | Phase matrix is computed (`phase_unwrapped_mean`) but **never consumed** by motion / occupancy / quality. It only ships down the wire as a number we don't use. | `features.py:152-157, 195` |
| 12 | No CFO / STO / phase-bias calibration. CSI-ratio path assumes adjacent subcarriers share CFO/STO; never validated. | `csi_ratio.py`, `biorhythm.py:368` |
| 13 | RSSI-stability denominator is a flat **8 dB**; doesn't normalise to link distance / path loss. | `features.py:244-246` |
| 14 | Empty-window fallback returns motion=0, occupancy=0 — indistinguishable from "no person, no motion". | `features.py:259-284` |
| 15 | `mark_respiration_experimental()` exists but is never imported by the runtime, so respiration values reach the API in spite of the doc claim that they're disabled. Either wire the gate or delete the function. | `services/dsp/src/respiration.py:6-11` vs `runtime.py:85-89` |
| 16 | Biorhythm resample target clamps to [2, 50] Hz; >50 Hz firmware would alias silently. | `biorhythm.py:261-266` |

### 1.3 API / transport

| # | Issue | Where |
|---|---|---|
| 17 | **No raw-frame surface at all** — `/ws/live` only emits `derived_window`; no REST endpoint returns raw frames. Today the only way to see I/Q is to `tail -f` the JSONL. | `apps/api/src/ws/live.py`, `apps/api/src/api/routes.py` |
| 18 | Agent and KB scaffolds aren't wired — already in `PROBLEMS.md` 2.1, 2.2. Out of scope for this plan. | — |
| 19 | TX status is hardcoded `unknown_until_hardware_check` — `PROBLEMS.md` 2.3. | — |

### 1.4 Web

| # | Issue | Where |
|---|---|---|
| 20 | `apps/web/features/aether-console.tsx` is **1,675 lines** containing 7 pages, 20+ subcomponents, all global state, calibration workflow, session lifecycle. | `aether-console.tsx` |
| 21 | App is a single-page conditional render (`page.tsx → RadioVisionConsole → if page === ...`). No Next.js routing → back button doesn't work. | `apps/web/app/page.tsx` |
| 22 | `wallClockMs` initialised to 0 to avoid hydration mismatch — readiness checklist briefly shows "muted" on first paint. Acceptable, but worth noting before splitting routes. | `aether-console.tsx:140` |
| 23 | Calibration polling is wall-clock bounded (`while Date.now() - start < (seconds + 4) * 1000`) instead of edge-triggered on `is_calibrating=false`. | `aether-console.tsx:218-224` |
| 24 | Confidence thresholds (0.30 / 0.45 / 0.75) hardcoded inline — no config UI. | `aether-console.tsx:1631-1636, 1144, 1157` |
| 25 | No frontend test runner — `PROBLEMS.md` 5.2. Existing component fixture only proves files compile. | — |

### 1.5 Docs

Already tracked in `PROBLEMS.md` §4 — pre-purge audit reports should move to
`docs/archive/`. Not blocking.

---

## 2. Calibration plan — get the numbers as accurate as the hardware allows

The order matters: each step assumes the previous one is in place. None of
this requires new hardware.

### Step 0 — Instrument the link (prereq for everything else)

Goal: stop guessing at packet rate. Today we don't know whether 6 Hz is TX,
Wi-Fi, or pyserial.

1. **TX cadence log** — every 200th TX packet, print µs since boot to UART.
   Lets us prove the firmware really is at 50 ms.
2. **RX inter-arrival histogram** — in `serial_reader.py`, accumulate
   inter-arrival deltas and emit a percentile log every 5 s
   (`p50 / p90 / p99 / max`).
3. **Drop-rate counter** — in `csi_capture.c`, increment a counter when
   `xQueueSendFromISR` returns full; expose via the heartbeat line.
4. **Switch `pyserial.readline()` → `read(inWaiting)`** — cheap experiment;
   `PROBLEMS.md` 1.1 already flags this. Gate the swap behind an env var
   (`AETHER_SERIAL_MODE=async`) so we can A/B.

Acceptance: heartbeat log shows actual TX cadence, actual RX delta histogram,
and a non-zero (or confidently zero) drop count. **Then** we can decide
whether to chase Wi-Fi channel scan or USB driver before re-running the
DSP work.

### Step 1 — Adapt to the *measured* packet rate

Replace `DEFAULT_EXPECTED_PACKET_RATE_HZ = 20.0` with a learned value.

- Add `RuntimeState.observed_packet_rate_hz` (EMA over the last 10 s).
- After 30 s, set `expected_packet_rate_hz = observed_packet_rate_hz` if it's
  stable to ±10 %.
- Surface both numbers in `/health` and in the UI Devices page.

This alone unfreezes the quality score; today it's pegged low not because the
data is bad but because the expectation is wrong.

### Step 1.5 — Adaptive Hampel + bandpass

- Hampel window: switch from 7 frames to ⌈350 ms · fs⌉ — keeps temporal
  semantics constant.
- Bandpass high edge: `min(5 Hz, 0.4·fs)` is OK; *log a warning* once if it
  clamps below 5 Hz so an operator knows motion >x Hz is being thrown away.

### Step 2 — Empty-room baseline (already exists, reuse)

`BaselineCalibrator` already captures per-subcarrier mean & std. Two
hardenings:

- Require ≥ 5 s and ≥ 100 frames (today: ≥ 10 s **or** ≥ 32 frames).
- Block calibration acceptance if **any** of: motion_score > current floor,
  packet_loss_ratio > 5 %, RSSI std > 4 dB during the window. Today the
  calibrator just averages whatever you give it.

UI: the existing `CalibrationCard` should refuse to show "calibrated" if the
checks above failed — show *why* it rejected.

### Step 3 — Subcarrier selection feedback loop

Today motion uses every subcarrier; biorhythm picks the responsive subset.
Make motion use the same set:

- After baseline, run `select_responsive_subcarriers()` once on a *known
  motion* clip (the existing `wave_hand` event).
- Persist `responsive_subcarriers: list[int]` on `BaselineCalibrator`.
- `derive_window()` filters its (T, S) matrix to those columns before
  computing motion / anomaly.

Acceptance: motion-during-stillness drops measurably (target ≥ 30 %)
without affecting motion-during-wave.

### Step 4 — Phase calibration

Today phase is computed and ignored. Two-phase rollout:

- Phase 4a (cheap, useful immediately): expose `phase_unwrapped_std` per
  subcarrier in the derived window. High phase variance correlates with body
  motion just like amplitude does — fold into motion as a secondary axis
  (weighted small until 4b validates it).
- Phase 4b (real fix, harder): per-frame CFO/STO removal using a linear fit
  across subcarriers (Wang & Liu, 2014, "PhaseFi" approach). Sign-off
  requires an empty-room sweep showing phase drift is bounded.

`[Inference]` Phase 4b will move respiration confidence noticeably; today
breathing detection rides only on amplitude.

### Step 5 — Geometry calibration (operator-supplied)

Required by the 3D view (§5). Today the only geometry "calibration" is a
docstring saying "1.5–2 m apart".

Add a new top-level config object — `RoomGeometry`:

```python
class RoomGeometry(StrictModel):
    schema_version: Literal["room_geometry.v1"] = "room_geometry.v1"
    room_extent_m: tuple[float, float, float]  # x, y, z bounding box
    tx_position_m: tuple[float, float, float]
    rx_position_m: tuple[float, float, float]
    tx_orientation_deg: float = 0.0   # yaw, ccw from +x
    rx_orientation_deg: float = 0.0
    subject_position_m: tuple[float, float, float] | None = None
    notes: str | None = None
```

- New routes: `GET/PUT /room/geometry` (persists in SQLite alongside session
  meta).
- A "Geometry" card on the Devices page with three numeric inputs per object.
- Validated against link distance estimated from RSSI / path loss — if
  user-entered TX-RX distance disagrees with RSSI-implied distance by >2×,
  surface a warning.

This is **operator data, not sensed data**. Label every UI surface that uses
it with `[Operator-supplied]`.

### Step 6 — End-to-end accuracy validation harness

Add `scripts/validate_accuracy.py`:

- Replays a known JSONL recording.
- Computes derived windows.
- Asserts: stillness segments → motion < threshold; movement events →
  motion > threshold; RSSI-stable → quality > 0.7.
- Outputs a single pass/fail with per-metric numbers.

Without this script every accuracy claim is anecdotal.

---

## 3. Raw-Sensor side tab

User ask: *"grab the raw sensor data … side tab for that in every way."*

Read as: a permanent left-side tab — accessible from any page — that exposes
**all** raw signal data per frame, not just the per-window aggregates we ship
today.

### 3.1 Backend additions

#### 3.1.1 New WS message type — `raw_frame`

Today `/ws/live` only sends `derived_window`. Add:

```jsonc
{ "type": "raw_frame",
  "frame": { ...RawCsiFrame... },
  "derived": {                    // computed inline, not stored
    "amplitude": [float, ...],    // per subcarrier
    "phase":     [float, ...],
    "subcarrier_count": int
  }
}
```

- Behind a per-connection subscribe message: client sends
  `{ "type": "subscribe", "topics": ["raw_frame"] }`. Default subscription is
  `["derived_window"]` (back-compat).
- Rate-limited server-side to a configurable max (default 20 Hz, drop
  oldest). If the link is faster than the WS can drain we drop, never
  block.

#### 3.1.2 New REST routes

| Method | Path | Returns |
|---|---|---|
| GET | `/sessions/{id}/frames?from_ns=&to_ns=&limit=` | Page of `RawCsiFrame[]` from the JSONL/SQLite store. Default limit 200, max 2000. |
| GET | `/sessions/{id}/frames/latest?n=` | Last *n* frames (default 50). |
| GET | `/diagnostics/link` | `{ observed_packet_rate_hz, expected_packet_rate_hz, inter_arrival_p50_ms, p99_ms, drop_count, rssi_p50_dbm, rssi_std_dbm, noise_floor_dbm, first_word_invalid_ratio }` — pulled from runtime EMAs added in §2 step 0. |
| GET | `/diagnostics/subcarriers` | `{ count, edges_dropped, indices_used, snr_per_subcarrier: [...], baseline_std: [...] }` — the calibration internals you can't see today. |

All gated behind the same `source_mode` semantics — replays are clearly
labelled, never silently substituted (`CLAUDE.md` rule).

### 3.2 UI — `Raw Sensor Data` side tab

Component: `apps/web/features/raw-sensor.tsx`. Routed at `/raw` (after the
Next.js routing migration in §4). Pinned in the sidebar under a new
`DIAGNOSTICS` section.

Layout — three stacked panels, full width:

1. **Frame inspector** — virtualised table (`DataTable.tsx` already in repo)
   of the most recent frames. Columns: `ts_host_ns`, `seq`, `rssi_dbm`,
   `noise_floor_dbm`, `payload_len`, `first_word_invalid`, mini-sparkline of
   amplitude across subcarriers. Click a row → drawer with full JSON +
   numeric I/Q array.
2. **Live spectrograms** — three charts side by side:
   - amplitude (subcarrier × time, dB)
   - phase (unwrapped, rad)
   - SNR vs. baseline
   Reuse `Spectrogram.tsx`; subscribe to `raw_frame` topic; draw a 200-frame
   rolling window.
3. **Link diagnostics** — `MetricCard` grid: observed Hz, expected Hz,
   inter-arrival p50/p99/max, drop count since session start,
   `first_word_invalid` ratio, RSSI mean/std, noise-floor mean.
4. **Subcarrier health** — bar chart of per-subcarrier SNR + baseline
   std + indicator showing which subcarriers are *currently used* by motion
   vs. biorhythm vs. dropped (after §2 step 3).

Performance budget: spectrograms must run at the WS rate (≤ 20 Hz updates) —
if they don't, drop frames and surface a "render-bound" warning.

---

## 4. UI reorganisation

### 4.1 Move from conditional render to Next.js routing

`apps/web/app/page.tsx` becomes the home (Live Room). Each existing virtual
page gets its own route folder:

```
app/
  page.tsx                     // Live Room (default)
  devices/page.tsx
  experiments/page.tsx
  data/page.tsx
  raw/page.tsx                 // NEW — §3.2
  3d/page.tsx                  // NEW — §5
  knowledge/page.tsx
  agent/page.tsx
  settings/page.tsx
  layout.tsx                   // wraps with sidebar + topbar
```

Back button works. Bookmarks work. Per-page state is independent.

### 4.2 Split `aether-console.tsx`

Extract once, in this order (each a separate commit so we can revert any
single step):

1. `features/sidebar.tsx` (Sidebar + nav, with new sections)
2. `features/topbar.tsx`
3. `hooks/useLiveStream.ts` (WS subscribe / reconnect / wall-clock tick)
4. `hooks/useRuntimeSnapshot.ts` (HTTP polling)
5. `features/live-room/*.tsx` — one file per card (SensingOverview,
   ReadinessChecklist, DeviceStatusCard, SessionCard, SignalQualityCard,
   CalibrationCard, RoomSummaryCard, RespirationCard, HeartBandCard,
   FidgetEnergyCard)
6. `features/devices.tsx`, `features/experiments.tsx`, etc.
7. Delete `aether-console.tsx`.

Each step is mechanically a move + import-fix. Tests (none today — see §6.4)
are added as part of step 5.

### 4.3 Sidebar gets a new layout

```
MONITORING
  · Live Room
DIAGNOSTICS                ← NEW
  · Raw Sensor Data
  · 3D Wave View
RESEARCH
  · Experiment Console
  · Data Explorer
KNOWLEDGE
  · Knowledge Base
  · Agent Console
SYSTEM
  · Devices
  · Settings
```

`Raw Sensor Data` and `3D Wave View` are intentionally one click away from
every page. Live Room remains the default landing surface — nothing in the
"trust" path moves.

---

## 5. 3D Wave View — research, design, scope

User ask: *"a section that I can pop out and have a real 3D view. birds eye,
side, etc., a real representation of the waves travelling, what's happening,
as if it's like animating me in 3D."*

### 5.1 Honest constraints (per `CLAUDE.md`)

What the hardware can prove: a single TX, a single RX, a per-packet CSI
vector. **Not** TDoA, not AoA, not multi-antenna MIMO, not pose. So:

- We can render a **physically plausible** wave-propagation animation —
  expanding spheres from TX, multipath rays bouncing off operator-supplied
  walls. Driven by *real* TX events (packet timestamps), modulated by *real*
  RSSI. The physics is illustrative; the modulation is grounded.
- We can render a **subject blob** at the operator-supplied subject position,
  with intensity = motion_score and radius = occupancy_score. Label:
  `[Operator-supplied position] [Sensed motion energy]`. Never call it
  "you" or "pose" or "skeleton" — `CLAUDE.md` forbids identity claims.
- We **cannot** render a tracked person moving around the room. We do not
  have positioning data. Any movement of the blob is operator-driven (drag
  in the scene) — not sensed.

If the user wants the blob to *track* movement, we'd need a multi-RX or
multi-antenna setup; that's V2 territory (`docs/ROADMAP.md`). Calling that
out explicitly in the UI — "Position is operator-supplied; intensity is
sensed" — is the responsible answer.

### 5.2 Tech choices

- `three` + `@react-three/fiber` + `@react-three/drei` — standard React
  ecosystem for declarative 3D. ~500 KB gzipped; we already accept Next.js
  + uPlot weight.
- No `@react-three/postprocessing` (bloom etc.) for V0 — visual sugar that
  can wait.
- No physics engine — wave propagation is procedural (analytic spherical
  expansion, not solved Maxwell).

### 5.3 Pop-out behaviour

Two modes, user picks:

- **In-page** — full-bleed within the `/3d` route, sidebar still visible.
- **Pop-out window** — `window.open('/3d?embed=1', 'aether-3d', 'width=1280,height=800,popup')`.
  When `embed=1`, layout drops the sidebar/topbar and goes full-canvas.
  Same WS connection (data flows independently from the launching tab via
  its own `useLiveStream`). Closing the popup is non-destructive.

### 5.4 Scene graph

```
<Canvas>
  <PerspectiveCamera />
  <OrbitControls />              // free orbit + keyboard
  <Grid />                       // floor grid in metres
  <Room>                         // wireframe box at room_extent_m
    <Walls />
    <Floor />
  </Room>
  <Antenna kind="tx" pos={tx_position_m} orientation={tx_orientation_deg} />
  <Antenna kind="rx" pos={rx_position_m} orientation={rx_orientation_deg} />
  <SubjectBlob
    pos={subject_position_m}
    motion={latestWindow.motion_score}
    occupancy={latestWindow.occupancy_score}
  />
  <PropagationField
    txPos={tx_position_m}
    pulses={latestRawFrames}    // each {ts, rssi}
    speedMps={3e8}              // c (illustrative — visually slowed)
    visualSpeedMps={2.0}        // animation speed for human eyes
  />
  <MultipathHints
    txPos={...} rxPos={...} room={...}
    refractionDepth={1}         // first-order bounces only
  />
  <SubcarrierCarpet
    txPos={...} rxPos={...}
    amplitudes={latestWindow.amplitude_mean}
  />
</Canvas>
<HUD>
  <CameraPresets />              // Birds-eye / Side / Front / Free
  <SourceBadge mode={sourceMode} />
  <Toggles>                      // turn each layer on/off
    pulses · multipath · subcarrier carpet · subject blob · room mesh
  </Toggles>
  <FrameRateMeter />
</HUD>
```

### 5.5 What each layer means

| Layer | Driven by | What the viewer sees | Honest label |
|---|---|---|---|
| `Antenna` (TX/RX) | `RoomGeometry` | Two boxes at the operator-given positions | `[Operator-supplied]` |
| `PropagationField` | every `raw_frame` event from WS | A glowing sphere expands from TX once per real packet; brightness = RSSI; speed visually slowed (c is too fast to see). | `[Sensed: TX cadence + RSSI]` `[Visual: speed slowed]` |
| `MultipathHints` | room walls + first-order specular bounces | Faint reflected ray paths from TX to RX via each wall once per pulse. | `[Illustrative: first-order specular only]` |
| `SubcarrierCarpet` | `derived_window.amplitude_mean[]` | A 2D "carpet" stretched between TX and RX, height = amplitude per subcarrier, colour = SNR. Updated every window. | `[Sensed]` |
| `SubjectBlob` | operator + `motion_score` + `occupancy_score` | A semi-transparent sphere at the operator-given subject position, radius = occupancy, internal noise = motion. | `[Operator-supplied position]` `[Sensed intensity]` |

### 5.6 Camera presets

- **Bird's-eye** — top-down ortho, +y down, locked.
- **Side** — orthographic from +x, looking at the TX-RX axis.
- **Front** — orthographic from -y.
- **Free** — `OrbitControls` enabled.

Bind to keys `1/2/3/4`. Smooth transitions via `useSpring` from `@react-spring/three` (already pulled in by drei).

### 5.7 Performance budget

Target 60 fps at 1080p with all layers on, ≤ 20 raw_frame events / s. Pulses
are pooled — at most 60 active spheres (3 s lifetime × 20 Hz). Spheres use
shared geometry + instanced material. SubcarrierCarpet is a single
`PlaneGeometry` with 52×N vertices, displaced in a vertex shader from a
DataTexture rebuilt on each window update.

### 5.8 Failure modes worth designing for

- **No geometry set yet** — show a card overlay: "Set room geometry on
  Devices → Geometry to enable the 3D view." Hide the canvas.
- **Replay mode** — overlay tints amber, big `REPLAY` watermark.
- **WS disconnected** — pulses freeze in place, watermark "STREAM PAUSED".
- **Hardware not delivering frames** — same as above; surfaces the same
  truth signal as the existing readiness checklist.

---

## 6. Build order, gates, and tests

### 6.1 Phase A — instrument the link (no UI changes)

1. TX cadence log (`firmware/esp32-s3-tx`).
2. RX inter-arrival histogram + drop counter (`firmware/esp32-s3-rx`,
   `serial_reader.py`).
3. New `/diagnostics/link` route.
4. `RuntimeState.observed_packet_rate_hz`.

Gate: heartbeat shows believable numbers, `/diagnostics/link` returns
non-zero values for >30 s.

### 6.2 Phase B — DSP hardening

5. Adopt observed packet rate.
6. Adaptive Hampel + bandpass-clamp warning.
7. Calibration acceptance checks.
8. Subcarrier selection feedback loop.
9. `phase_unwrapped_std` exposed; small weight in motion.
10. `scripts/validate_accuracy.py` with at least one known-good replay
    asserting motion / quality bounds.

Gate: validation script passes on an empty-room replay (motion < 0.2) and a
wave-hand replay (motion > 1.0).

### 6.3 Phase C — Raw Sensor surface

11. WS subscribe protocol; `raw_frame` topic.
12. `/sessions/{id}/frames`, `/diagnostics/subcarriers` routes.
13. JSON Schemas + `tests/e2e/protocol-schema.test.mjs` extended.

Gate: e2e protocol tests still pass; new routes return data; no regression
in `/ws/live` default behaviour.

### 6.4 Phase D — UI reorganisation + Raw Sensor tab

14. Add Vitest + Testing Library (closes `PROBLEMS.md` 5.2).
15. Split `aether-console.tsx` per §4.2.
16. Migrate to Next.js routing per §4.1.
17. Build `/raw` per §3.2.

Gate: `npx tsc --noEmit -w @aether/web` clean; smoke test suite green;
manual: all existing pages still render with same data.

### 6.5 Phase E — Geometry + 3D view

18. `RoomGeometry` model + routes + Devices card.
19. `/3d` route, scene graph per §5.4.
20. Pop-out window mode.
21. Layer toggles + camera presets.
22. Honest labels per §5.5.

Gate: with geometry set, `/3d` renders pulses synchronised with `raw_frame`
WS events at 60 fps; replay mode shows the watermark; no geometry set
shows the empty-state overlay.

### 6.6 Test plan (cross-cutting)

- Backend: extend `pytest` suite for new routes, calibrator acceptance
  rules, subcarrier-selection persistence.
- Protocol: schema additions covered by `tests/e2e/protocol-schema.test.mjs`.
- Web: Vitest smoke tests for each new component (`Sidebar`,
  `RawSensorPanel`, `LinkDiagnosticsCard`, `Scene3D` render-without-throw).
- Manual: walk through `docs/EXPERIMENT_PLAN.md` protocols (empty room,
  presence, motion) on the new UI; verify Raw Sensor tab numbers match the
  Live Room numbers; verify 3D pulses match `/diagnostics/link.observed_hz`.

### 6.7 Out of scope for this plan

- Wiring the Agent / KB scaffolds (`PROBLEMS.md` 2.1, 2.2).
- TX firmware health endpoint (`PROBLEMS.md` 2.3).
- Multi-antenna / MIMO sensing.
- Identity, pose, HRV, or any health-grade physiology claims.
- Through-wall sensing.

These remain forbidden by `CLAUDE.md` and unchanged by anything proposed
above.

---

## 6.8 Implementation status (v0.2)

| Phase | Item | Where it lives | Status |
|---|---|---|---|
| A | TX cadence µs log | `firmware/esp32-s3-tx/main/app_main.c` | ✅ shipped — needs flash |
| A | RX queue overflow counter | `firmware/esp32-s3-rx/main/csi_capture.c` | ✅ shipped — needs flash |
| A | RX heartbeat carries dropped + queue depth | `firmware/esp32-s3-rx/main/serial_protocol.c` | ✅ shipped — needs flash |
| A | Host-side `LinkStats` (EMA Hz, jitter histogram) | `apps/api/src/services/link_stats.py` | ✅ shipped |
| A | `/diagnostics/link` REST | `apps/api/src/api/routes.py` | ✅ shipped |
| A | Adopt observed packet rate as expected | `apps/api/src/services/runtime.py` | ✅ shipped |
| B | Adaptive Hampel half-window in time | `services/dsp/src/features.py` | ✅ shipped |
| B | Bandpass clamp warning (one-shot) | `services/dsp/src/features.py` | ✅ shipped |
| B | Calibration acceptance gates (frames, rate floor, RSSI σ, motion) | `services/dsp/src/calibration.py` | ✅ shipped |
| B | Shared responsive-subcarrier subset | `services/dsp/src/features.py` + calibrator | ✅ shipped |
| B | `phase_unwrapped_std` exposed + folded into motion | `services/dsp/src/features.py` | ✅ shipped |
| B | CFO/STO removal (per-frame linear-phase fit) | `services/dsp/src/preprocessing.remove_linear_phase_per_frame` | ✅ shipped |
| B | `validate_accuracy.py` replay harness | `scripts/validate_accuracy.py` | ✅ shipped |
| C | `raw_frame` WS topic + subscribe protocol | `apps/api/src/ws/live.py` | ✅ shipped |
| C | `/sessions/{id}/frames[/latest]` REST | `apps/api/src/api/routes.py` + session_store | ✅ shipped |
| C | `/diagnostics/subcarriers` | `apps/api/src/api/routes.py` + runtime | ✅ shipped |
| C | `room_geometry.v1` model + persistence + REST | protocol + session_store + routes | ✅ shipped |
| D | Shared shell layout (sidebar + topbar) | `apps/web/features/shell/*` | ✅ shipped (new routes only; legacy `/home` not yet split) |
| D | `/raw` Raw Sensor Data page | `apps/web/app/raw/page.tsx` + `features/raw-sensor.tsx` | ✅ shipped |
| D | `useLiveStream` hook | `apps/web/lib/use-live-stream.ts` | ✅ shipped |
| D | TopBar quick-jump links to /raw, /3d, /devices-v2 | `apps/web/features/aether-console.tsx` | ✅ shipped |
| D | Vitest setup | — | ⏳ deferred |
| D | Full split of `aether-console.tsx` (1,675 lines) | — | ⏳ deferred — quick-jump links unblock the new surfaces meanwhile |
| E | 2D floorplan + numeric geometry editor | `apps/web/features/devices-v2.tsx` | ✅ shipped |
| E | 3D scene (TX/RX/subject/pulses/multipath/carpet) | `apps/web/features/three-d/scene.tsx` | ✅ shipped |
| E | Camera presets + layer toggles + pop-out window | `apps/web/features/three-d/three-d-page.tsx` | ✅ shipped |
| — | Linux live-USB OS comparison test | — | manual / out of repo |
| — | Pi-as-collector experiment | — | not started; gated on Phase A heartbeat data |

## 7. Open questions for the user

Before any code is written I need answers on:

1. **Geometry input UX** — three numeric fields per object (TX, RX, subject)
   feels minimal. Want a 2D mini-floorplan editor instead, or is a numeric
   form fine for V0?
2. **Pop-out vs full-screen** — both, as proposed? Or just one?
3. **Subject blob** — confirm: operator places it, intensity comes from
   `motion_score`. We do **not** sense position. Yes/no.
4. **Phase 4b (CFO/STO removal)** — bigger change, multi-day. Scope it into
   this round, or separate PR after the rest lands?
5. **Pre-flight on Phase A** — comfortable touching firmware? If not, we can
   do everything host-side first and circle back to firmware logs once host
   instrumentation makes the case obvious.
