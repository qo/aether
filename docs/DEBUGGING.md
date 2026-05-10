# Debugging & Logging Reference

This document is the operator's map for figuring out *what is going wrong* in
Aether. Every log line in the system follows the conventions described
here, so once you know the shape you can grep, filter, or scroll without
guessing.

---

## 1. Where logs come out

| Surface | Stream |
|---------|--------|
| FastAPI / collector / DSP / WS | `stderr` of the API process (uvicorn) |
| Next.js dev server (Turbopack) | `stdout` / `stderr` of the `next dev` process |
| React + browser-side (api fetches, websocket, global errors) | Browser devtools **Console** |

The browser shows server-side problems too, when a fetch fails or the
WebSocket disconnects — those are tagged `[rv:api]` / `[rv:ws]`.

---

## 2. Tag legend

### Backend (Python)

Backend log lines look like:

```
17:42:11.348 INFO  apps.api.src.api.routes | [route] start_session id=abc123 mode=LIVE replay_path=None serial_port=COM5
^^^^^^^^^^^^ ^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
clock        level logger                       message (with bracketed [tag] prefix)
```

| Tag | What it covers | Where it lives |
|-----|----------------|----------------|
| `[boot]` | App startup, config dump, FastAPI lifecycle, shutdown | `apps/api/src/main.py`, `apps/api/src/logging_setup.py` |
| `[http]` | Every HTTP request: `>>` start, `<<` finish (status + ms). Slow (>750 ms) requests are WARN. | `apps/api/src/http_logging.py` |
| `[route]` | Explicit per-route lines for the actions that change state (session create/start/stop, event write, calibration begin/cancel/reset). | `apps/api/src/api/routes.py` |
| `[ws]` | WebSocket connect/disconnect, hello frames, periodic "sent N derived windows in 5s" rate report, handler exceptions. | `apps/api/src/ws/live.py` |
| `[runtime]` | Collector + DSP heartbeats: frames seen, windows emitted, motion/occupancy/quality at 50-window intervals; start/stop transitions for the source task. | `apps/api/src/services/runtime.py` |
| (no tag) | Older calls inside `services/collector/src/serial_reader.py` etc. They use the same root logger and format, so they show up alongside everything else. | various |

#### Verbosity

The default level is **INFO**. Per-frame chatter and HTTP request bodies are
emitted at **DEBUG**. To see them:

```powershell
$env:AETHER_LOG_LEVEL = "DEBUG"
python -m uvicorn apps.api.src.main:app --reload
```

Set it back to `INFO` once you know what's happening.

### Frontend (Browser console)

Frontend lines look like:

```
[rv:api] GET sessions:list http://127.0.0.1:8000/sessions   { …data… }
```

| Tag | What it covers | Where it lives |
|-----|----------------|----------------|
| `[rv:boot]` | One banner on app start with the resolved API + WS URLs and the user agent. Also installs `window.onerror` / `unhandledrejection` listeners. | `apps/web/lib/devlog.ts` (`<DevBootstrap/>`) |
| `[rv:api]` | Every HTTP request to the FastAPI backend. Logs `> METHOD label url` at debug, `< … (XX.X ms)` on completion at info, status + body on non-2xx at error. | `apps/web/lib/api.ts` (`rvFetch`) |
| `[rv:ws]` | WebSocket lifecycle: `attempt N: opening`, `open`, `close; will reconnect in 2500 ms`, `error event`, `client requested disconnect`. Plus a 5-second message-rate counter at debug. | `apps/web/lib/api.ts` (`connectLive`) |
| `[rv:state]` | Reserved for component-level state transitions worth recording. Not used by default to keep the console quiet — add ad hoc when chasing a bug. | anywhere (import `devlog` from `lib/devlog`) |
| `[rv:error]` | Global `window.error` and `unhandledrejection` events. If you see one of these, something escaped a try/catch — look at the trace next to it. | `apps/web/lib/devlog.ts` |

#### Filtering in Chrome devtools

In the Console filter box:

| Recipe | Effect |
|--------|--------|
| `rv:api` | only HTTP traffic |
| `rv:ws` | only WebSocket lifecycle |
| `rv:(api\|ws)` (regex) | network-y stuff only |
| `-rv:ws` | hide ws (useful when you're chasing an HTTP bug) |
| level filter "Errors" | global errors + failed fetches only |

The level prefix (`debug` / `info` / `warn` / `error`) is the standard
console method, so the devtools level dropdown also works.

---

## 3. Common symptoms → which logs to read

### "The UI shows offline / disconnected"

1. Check `[rv:ws]` in the browser console.
   - `attempt N: opening …` followed by `error event` ⇒ the API isn't
     reachable from the browser. CORS, port, or process not running.
   - `open` followed by `close; will reconnect …` ⇒ server accepted then
     dropped. Look for `[ws] !! handler raised` on the backend.
2. Check `[ws]` in the API stderr.
   - No `[ws] >> connect` line at all ⇒ browser never reached the server.
   - `connect` then no `derived windows in 5s` lines ⇒ DSP isn't producing
     output. Look for `[runtime] collector heartbeat`.

### "I started a session but no data appears"

1. Look for `[route] start_session id=… mode=LIVE serial_port=COM…` in API.
2. Then `[runtime] start_live port=… session=…`.
3. If neither appears, the request never reached the route — check the
   matching `[http] >>` line and the response status.
4. If start_live ran but no `[runtime] collector heartbeat: frames=100 …`
   shows up within a few seconds, the serial reader is stuck. Re-check
   `AETHER_SERIAL_PORT` and that the RX board is producing CSI.

### "API requests are slow"

`[http]` lines log duration. Anything over 750 ms is auto-WARN.
Long ones with `/sessions/{id}/summary` usually mean a large recording is
being scanned — check `data/recordings`.

### "Hydration mismatch in the browser"

If you see warnings like `bis_register=…` or `__processed_…` on `<body>`,
that's a browser extension and is now suppressed via `suppressHydrationWarning`
on `<body>` (and only `<body>` — see `apps/web/app/layout.tsx`). If you see a
mismatch on **any other** element, it is real and needs to be fixed.

### `ChunkLoadError` in the browser console / "WebSocket dropped (HTTP still works)"

Symptom (browser console):

```
ChunkLoadError: Failed to load chunk /_next/static/chunks/...js
```

What it means: Turbopack served a page referring to a chunk hash that no
longer exists, usually because the module graph changed during dev (a new
import was added, hot reload partially applied). The unhandled rejection
kills React's render loop and the live socket gets torn down with it. The
HTTP API keeps working — the readiness checklist will show `WebSocket /ws/live
connected: warning` and `API reachable: success`, and the disconnected
banner will say *"WebSocket dropped (HTTP still works)"*.

Fix:

```powershell
# stop next dev (Ctrl-C in that terminal)
Remove-Item -Recurse -Force apps\web\.next
npm run web:dev
```

Then hard-reload the browser tab (Ctrl-Shift-R) so it doesn't replay the
bad chunk URL from the disk cache.

### "Frontend is throwing but I can't see why"

`[rv:error]` lines from `window.onerror` or `unhandledrejection` will print
the error object alongside the message. Expand the object in the console to
see the stack. If it didn't surface there, it was probably swallowed by a
React error boundary — search the codebase for `componentDidCatch` (none
today) or wrap the suspect component in one.

---

## 4. Files involved (quick map)

```
apps/api/src/
  logging_setup.py           # one-time root-logger config, AETHER_LOG_LEVEL knob
  http_logging.py            # RequestLoggingMiddleware (HTTP [http] tag, ms timing, req_id)
  main.py                    # wires the above + boot lines
  api/routes.py              # [route] tags on session + calibration mutations
  ws/live.py                 # [ws] tags + 5-second send-rate report
  services/runtime.py        # [runtime] heartbeats every 100 frames / 50 windows

apps/web/
  app/layout.tsx             # mounts <DevBootstrap/>, sets suppressHydrationWarning on <body>
  lib/devlog.ts              # devlog module + <DevBootstrap/>, global error hooks
  lib/api.ts                 # rvFetch wrapper + connectLive WS lifecycle logs

docs/DEBUGGING.md            # this file
```

---

## 5. Adding new logs

If you add a new code path that mutates runtime state, network state, or the
session store, log it. Pick the right tag:

- mutating an HTTP-driven thing? → `[route]` (backend) / `[rv:api]` (frontend)
- pushing or receiving on a socket? → `[ws]` / `[rv:ws]`
- changing the source task or DSP? → `[runtime]`
- starting up or shutting down a worker? → `[boot]`

Keep the message terse but unambiguous. Include identifiers (session id,
device, file path) so a future you can grep the log for the right line.
