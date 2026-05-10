# Known Problems

Last updated 2026-05-10 after end-to-end audit. This file is the honest log
of what's broken, half-built, or risky in the repo right now. Each entry is:

- **Symptom** — what you'd actually observe
- **Root cause** — why it happens (where in the code)
- **Severity** — Blocker / Major / Minor / Cosmetic / Scaffolding
- **Fix sketch** — what would resolve it

Entries are grouped by area. If you fix one, delete it from this file (don't
just strike it through — the file is meant to stay short).

---

## 1. Hardware / firmware

### 1.1 Live packet rate is ~6 Hz, target is ~20 Hz
**Severity:** Major (functional but degraded).
**Symptom:** `[runtime] collector heartbeat: frames=100 windows=90 buffered=40` over ~17 s; `[ws] sent N derived windows in 5.0s (5.8 /s)`. The TX firmware is documented to emit at 50 ms cadence (~20 Hz) — see `firmware/esp32-s3-tx/main/tx_config.h` and `apps/api/src/services/runtime.py:DEFAULT_EXPECTED_PACKET_RATE_HZ = 20.0`.
**Root cause (suspected, not confirmed):** Several plausible contributors —
Wi-Fi link quality (multipath / channel congestion in 2.4 GHz), TX firmware's
actual transmit interval not matching its config, Windows `pyserial.readline()`
latency, or a serial buffer flush issue. We have no instrumentation to
isolate which.
**Fix sketch:**
1. Add a TX-side debug log of actual TX cadence (microsecond timestamps).
2. Measure RX-side packet inter-arrival in `services/collector/src/serial_reader.py`.
3. If TX cadence is correct, try a Wi-Fi channel scan and pin the TX/RX to a
   quiet channel.
4. If the bottleneck is `pyserial`, try `serial.Serial(... timeout=0)` plus a
   manual `inWaiting()` loop instead of `readline()`.

### 1.2 COM9 (TX board USB endpoint) cannot be opened — PermissionError 13
**Severity:** Minor (does not block operation; we don't need to read TX).
**Symptom:** `scripts/probe_serial.py COM9` returns `open failed: PermissionError(13, 'A device attached to the system is not functioning.', None, 31)`.
**Root cause (suspected):** ESP32-S3 dev kits expose two USB endpoints when
the TX firmware uses the second JTAG/serial pair; the Windows driver may
register one of them in a state pyserial cannot open. Doesn't matter for
operation — the TX board only needs power; we never read from it.
**Fix sketch:** Document on the Devices page that COM9 is expected to be
unreadable, so an operator doesn't think the board is broken. (Already done
implicitly by the Devices page showing TX as "unknown_until_hardware_check".)

---

## 2. Code rot / scaffolding not wired

### 2.1 Agent (`services/agent/`) is built but never reachable
**Severity:** Scaffolding (intentional, not a bug, but flagged).
**What exists:** `services/agent/src/room_agent.py` (`RoomAgent.answer()`) and
`services/agent/src/room_tools_mcp.py` (`RoomTools` with
`get_live_room_summary`, `get_recent_derived_windows`, `search_knowledge_base`,
etc.). 1 test in `services/agent/tests/test_agent.py`.
**What's missing:** No FastAPI route imports it. No UI page calls it. The
"Agent Console" page in the UI explicitly says "Agent unavailable. No
existing API endpoint exposes grounded agent tool output."
**Fix sketch (V1):** Add `/agent/ask` route in `apps/api/src/api/routes.py`
that constructs `RoomAgent(RoomTools(store=state.store, kb_root=settings.kb_root))`
and returns `agent.answer(question)`. Wire the existing UI page to it.

### 2.2 Knowledge Base (`services/kb/`) is built but never reachable
**Severity:** Scaffolding.
**What exists:** `services/kb/src/{ingest,search,schemas}.py`. Test in
`services/kb/tests/test_search.py` (passing).
**What's missing:** Only `RoomTools` references `kb_search`, and `RoomTools`
itself isn't wired (see 2.1). No `/kb/search` route exists. UI's Knowledge
Base page says "KB API unavailable".
**Fix sketch (V1):** Add `/kb/search?q=…` route that delegates to
`services.kb.src.search.search_knowledge_base`.

### 2.3 TX board status is hardcoded
**Severity:** Minor.
**Where:** `apps/api/src/api/routes.py:39-48` — `tx.status =
"unknown_until_hardware_check"` always. There is no firmware-health endpoint
on either board.
**Fix sketch:** Either (a) add a firmware heartbeat protocol (TX emits a
heartbeat over USB even though it's primarily transmit-only), or (b) probe
the OS for whether the COM port is enumerated.

### 2.4 `Devices` page conflates "Backend status" with "RX status"
**Severity:** Cosmetic.
**Where:** `apps/web/features/aether-console.tsx`, `Devices` component.
The two values are derived from different sources and the duplicate label can
confuse. Already mostly cleaned up (now shows separate WS / Collector / DSP
rows).
**Fix sketch:** Drop the "Backend status" code field from the kvList; it's
redundant with the row above.

---

## 3. Frontend dev-experience hazards

### 3.1 Turbopack `ChunkLoadError` after rapid hot-reload
**Severity:** Minor in dev (auto-recovers); does not affect production.
**Symptom:** Browser console shows `ChunkLoadError: Failed to load chunk
.../node_modules_next_dist_client_components_builtin_global-error_…js`.
React's render loop dies, page becomes uninteractive.
**Root cause:** When `next dev` rebuilds while a tab is open, the manifest
points to chunk hashes the browser doesn't have. Server-rendered HTML and
client chunks fall out of sync.
**Mitigations in place:**
- `lib/devlog.ts` auto-reloads the page on `ChunkLoadError` in dev (10 s
  cooldown to avoid loops).
- `wallClockMs` initialises to `0` (not `Date.now()`) so SSR and the first
  client render produce identical strings.
- `suppressHydrationWarning` on dynamic spans in `SensingOverview`.
**Manual recovery if auto-reload doesn't catch it:** Ctrl-C the dev server,
`Remove-Item -Recurse -Force apps\web\.next`, restart, hard-reload tab
(Ctrl-Shift-R, not just F5).

### 3.2 Browser-extension hydration noise
**Severity:** Cosmetic (handled).
**Where:** `apps/web/app/layout.tsx` — `<body suppressHydrationWarning>`.
Extensions like Bitdefender / 1Password inject `bis_register`, `__processed_…`
attributes onto `<body>`, which look like a hydration mismatch but aren't.
The flag suppresses it on `<body>` only — real mismatches in the React tree
still throw.

---

## 4. Documentation rot

### 4.1 Three docs are pre-refactor audit reports kept for history
**Severity:** Cosmetic.
**Files:** `docs/PURGE_AUDIT.md`, `docs/UI_AUDIT.md`,
`docs/REFACTOR_COMPLETION.md`, `docs/REPO_TRUTH_AUDIT.md`. They describe the
state of the repo *before* the May 2026 simulation purge / UI refactor.
Useful as historical record; misleading if read as current state.
**Fix sketch:** Move them under `docs/archive/` (or prefix filenames with
`_archive_`) so the directory listing makes their status obvious.

### 4.2 `docs/UI_SPEC.md` was missing the readiness checklist & disconnected banner
**Status:** Fixed in this session.

### 4.3 `docs/SETUP.md` didn't mention `.env` loader or `setup_local.ps1`
**Status:** Fixed in this session.

---

## 5. Observability / DX gaps

### 5.1 Tests are runnable but not gated locally pre-push
**Severity:** Minor.
**Symptom:** Nothing prevents committing code that fails `npm test` or
`pytest`. CI catches it on push, but feedback is delayed.
**Fix sketch:** Add a `.husky/pre-commit` that runs `npm test && python -m
pytest -q`. Or document the manual command in CONTRIBUTING.md.

### 5.2 No frontend test runner
**Severity:** Minor.
**Symptom:** `apps/web/tests/component-fixture.tsx` exists but only ensures
components compile; there is no Jest/Vitest/Playwright in the web workspace.
**Fix sketch:** Add Vitest + Testing Library and write at least smoke tests
for `DisconnectedBanner` (one snapshot per `DisconnectedReason` value).

### 5.3 No structured-log JSON output
**Severity:** Minor.
**Symptom:** Today's logs are human-readable text. Fine for `tail -f`; not
parseable by log aggregators.
**Fix sketch:** Add an `AETHER_LOG_FORMAT=json` switch in
`apps/api/src/logging_setup.py` that swaps the formatter for one emitting
JSON-per-line (`{"ts":..., "level":..., "logger":..., "msg":..., "tag":...}`).

---

## 6. Things deliberately NOT in scope (per `CLAUDE.md`)

These are *not* problems — they're scope boundaries you might wish were
features. Listed so nobody files an "implement HRV" ticket.

- No heartbeat / HRV / identity / emotion / through-wall sensing.
- No medical-grade physiology claims.
- No cloud sync, no auth, no telemetry.
- No multi-room / multi-link aggregation.
- No "demo" or "synthetic" data path — `scripts/no_nonreal_data_check.mjs`
  enforces this on every CI run.
