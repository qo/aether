# Troubleshooting

First-response recipes for common failure modes. For deeper signal-tracing,
read [`DEBUGGING.md`](DEBUGGING.md) (log tag reference). For known
unresolved issues with root-cause analysis, see [`../PROBLEMS.md`](../PROBLEMS.md).

## Decision tree

```
Can you reach http://localhost:3000 at all?
  no  → web dev server not running (npm run web:dev)
  yes ↓
Does the browser console show [rv:boot]?
  no  → Hydration crashed early. See § "ChunkLoadError / page won't hydrate".
  yes ↓
Readiness checklist row "API reachable" green?
  no  → uvicorn not running. python -m uvicorn apps.api.src.main:app --reload
  yes ↓
"WebSocket /ws/live connected" green?
  no  → see § "WebSocket dropped, HTTP works"
  yes ↓
"Serial port configured" green?
  no  → run .\scripts\setup_local.ps1, or set AETHER_SERIAL_PORT in .env
  yes ↓
"Session started" green?
  no  → click Start session in the disconnected banner
  yes ↓
"CSI frames flowing" green within 5 s?
  no  → see § "Session running but no CSI frames"
  yes → you're live; calibrate next.
```

## Symptom recipes

### `setup_local.ps1` says no port emits CSI

Causes, in order of likelihood:

1. **Another process owns the port.** PuTTY, Arduino IDE Serial Monitor, the
   ESP-IDF monitor, or even a previous uvicorn still has it open. Close them.
2. **Boards aren't flashed.** Run `scripts/flash_rx.ps1` and `flash_tx.ps1`.
3. **Wrong USB cable.** Power-only cables are common. Use a known data cable.
4. **TX board isn't powered.** RX needs RF energy from TX to produce CSI. The
   `[probe] csi=0 hb=N` case (heartbeats but no CSI) usually means this.

### `[boot] settings ... serial_port=None` after running `setup_local.ps1`

The `.env` file isn't being loaded. Verify:

- The file is at the **repo root** (same directory as `package.json` and
  `pyproject.toml`), not under `apps/api/`.
- It's named exactly `.env` (no `.txt`, no `.example`).
- The line reads `AETHER_SERIAL_PORT=COM10` (no quotes needed).
- You restarted uvicorn after creating `.env`. The loader runs once per
  process.

### Session running but no CSI frames

API log shows `[runtime] start_live port=COMx ...` but no
`[runtime] collector heartbeat: frames=100 ...` within 5 s. Check, in order:

1. Is the TX board powered? It draws ~80 mA — a phone charger USB port works.
2. Are the antennas oriented usefully? PCB chip antennas are directional.
3. Is the link distance reasonable (1.5 m – 2 m, line of sight)?
4. Look at `services.collector.src.serial_reader` log lines for
   `serial port error` / `serial stall` (means physical disconnect).

### WebSocket dropped, HTTP works

Banner says "WebSocket dropped (HTTP still works)." This is dev hot-reload
fallout. Recovery:

```powershell
# Ctrl-C the next dev terminal
Remove-Item -Recurse -Force apps\web\.next
npm run web:dev
# Then in browser: hard reload (Ctrl-Shift-R)
```

The frontend's `lib/devlog.ts` will auto-reload on `ChunkLoadError` in dev,
but if the WS dropped without throwing one, the manual recovery is needed.

### `ChunkLoadError` / page won't hydrate

Same root cause as above. Auto-reload should kick in within a second; if it
loops or doesn't fire, do the manual recovery. See PROBLEMS.md § 3.1.

### Frame rate ~6 Hz instead of ~20 Hz

Documented as a Major issue in [`../PROBLEMS.md`](../PROBLEMS.md) § 1.1.
Several plausible causes (Wi-Fi congestion, TX cadence, pyserial latency on
Windows). Doesn't block use — DSP, UI, storage all behave correctly at this
rate.

### Hydration mismatch warning on `<body>` only

Caused by browser extensions (Bitdefender, password managers) injecting
attributes after SSR. Suppressed via `suppressHydrationWarning` on `<body>`
in `apps/web/app/layout.tsx`. Real React-tree mismatches still throw loudly.

### `npm test` crashes on `EPERM scandir .pytest_cache`

Fixed: `scripts/no_nonreal_data_check.mjs` now soft-skips unreadable dirs and
ignores `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, and the whole `data/`
tree. If you see this again, your `.gitignore` or the script ignore list is
out of sync — check `scripts/no_nonreal_data_check.mjs`.

### Tests pass locally but fail on CI

The CI job pinned in `.github/workflows/ci.yml` runs three lanes in parallel:
`npm test`, `python -m pytest -q`, and `tsc --noEmit` on the web workspace.
Run all three locally before pushing — if one passes locally and fails on
CI, suspect platform differences (line endings, locale, missing `.env`).

## Where to look when nothing here fits

- `docs/DEBUGGING.md` — log tag reference. `grep '\[ws]'` or
  `grep '\[runtime]'` in the API log narrows fast.
- Browser devtools Console with filter `rv:` — frontend lifecycle.
- `PROBLEMS.md` — open issues with root cause analysis.
- `docs/DECISION_LOG.md` — why something is the way it is.
