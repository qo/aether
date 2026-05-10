# ABOUT — Aether (Wi-Fi CSI Sensing Instrument, v0.2)

> Audience: AI agent. This document indexes the *live* system only. Inactive scaffolding,
> archive material, vendored deps, generated artefacts, and unreachable functions are
> excluded except where their presence is structurally relevant.

---

## 1. SYSTEM IDENTITY

- **What it is:** local-first Wi-Fi Channel-State-Information (CSI) sensing pipeline that
  ingests 802.11n CSI from a paired ESP32-S3 RX/TX bracket over USB-CDC, derives motion /
  occupancy / link-quality / (research-only) respiration features, persists per-session
  raw + derived data, and visualises the results in a Next.js console.
- **Primary function:** convert per-packet CSI (I/Q int8 vectors + RF metadata) into
  windowed `DerivedWindow` features streamed live to a browser, with optional replay from
  recorded JSONL.
- **Runtime environment:** single-host. Python 3.12 backend (FastAPI/uvicorn) listens on
  `127.0.0.1:8000`; Next.js 16 frontend on `:3000`; firmware on two ESP32-S3 boards over
  CH343/CP210x USB-UART. No cloud, no auth, no telemetry.
- **Languages / frameworks:** Python 3.12 (FastAPI 0.115+, Pydantic v2.8+, NumPy 2,
  SciPy 1.14, pyserial); TypeScript 5.6 (Next.js 16, React 19, uPlot 1.6,
  @react-three/fiber 9, three 0.169, @tanstack/react-table+virtual); ESP-IDF C
  (FreeRTOS, esp_wifi).
- **Active version marker:** `pyproject.toml` `name="aether"`, `version="0.1.0"`,
  `requires-python=">=3.12"`. `package.json` `"version": "0.1.0"`. AppShell brand reads
  `v0.2`. README banner labels current scope **v0.2**.

---

## 2. ACTIVE ENTRYPOINTS

| Name | Type | Trigger | Responsibility |
|---|---|---|---|
| `apps/api/src/main.py:app` | ASGI app | `python -m uvicorn apps.api.src.main:app` | Configures logging, loads `.env`, builds `SessionStore`+`RuntimeState`, mounts `health_router`+`build_router(state)`, exposes `/ws/live` |
| `apps/api/src/main.py:ws_live` | WebSocket | client connect to `/ws/live` | Delegates to `live_websocket()` |
| `apps/api/src/main.py:_startup` / `shutdown` | FastAPI lifecycle | uvicorn boot/exit | Logs route count; `state.stop()` cancels source task |
| `apps/web/app/page.tsx` | Next.js client route `/` | browser GET | Three.js landing scene; `router.push("/home")` on click |
| `apps/web/app/home/page.tsx` | Next.js client route `/home` | browser GET | Mounts legacy `RadioVisionConsole` (Live Room, Devices, Experiment Console, Data Explorer, Knowledge Base, Agent Console, Settings tabs) |
| `apps/web/app/raw/page.tsx` | Next.js client route `/raw` | browser GET | Dynamic-import `features/raw-sensor.tsx` (frame inspector + spectrograms) |
| `apps/web/app/3d/page.tsx` | Next.js client route `/3d` | browser GET | Dynamic-import `features/three-d/three-d-page.tsx` (operator-supplied geometry + RF pulses) |
| `apps/web/app/devices-v2/page.tsx` | Next.js client route `/devices-v2` | browser GET | Dynamic-import `features/devices-v2.tsx` (link telemetry + room geometry editor) |
| `firmware/esp32-s3-rx/main/app_main.c:app_main` | ESP-IDF entry | board boot | Wi-Fi STA join, `rv_csi_init()`, spawns `udp_sink_task` (core 0) + `serial_task` (core 1) |
| `firmware/esp32-s3-tx/main/app_main.c:app_main` | ESP-IDF entry | board boot | Wi-Fi SoftAP, spawns `udp_sender_task` (50 ms cadence broadcast) |
| `scripts/setup_local.ps1` | PowerShell CLI | operator | Creates venv, installs project, enumerates COM ports, probes via `probe_serial.py`, writes `.env` |
| `scripts/probe_serial.py` | Python CLI | operator / setup script | Opens each given port for 4 s, classifies via `parser.parse_serial_line` |
| `scripts/validate_accuracy.py` | Python CLI | operator (CI candidate) | Replays a `.jsonl` through `derive_window`, asserts rate/quality/motion sanity bounds |
| `scripts/no_nonreal_data_check.mjs` | Node CLI | `npm test` / CI | Greps the tree for banned `simu*late`/`Mock*Csi`/etc. patterns, exits non-zero on hit |
| `tests/e2e/protocol-schema.test.mjs` | Node CLI | `npm test` / CI | Asserts JSON-Schema invariants for `csi_frame.v1`, `derived_window.v1`, `experiment_event.v1` |
| `scripts/flash_rx.ps1` / `flash_tx.ps1` | PowerShell CLI | operator | `idf.py set-target esp32s3 && build && flash` |
| `scripts/record_session.ps1` | PowerShell CLI | operator | POST `/sessions` then `/sessions/<id>/start` against the API |

---

## 3. ARCHITECTURE OVERVIEW

```
                       (over-air 802.11n, ch6, BW20)
  ESP32-S3 TX  ====================================>  ESP32-S3 RX
  (SoftAP        50 ms-cadence UDP                   (STA, csi_rx_cb -> queue
   AETHER_V0,    broadcast packets;                   depth 64 -> serial_task
   ch 6,         emits cadence log                    @ APP_CPU; UART 921600)
   broadcast     every 200 packets)                            |
   192.168.4.1)                                                | USB-CDC JSONL
                                                               | {"type":"csi"|"heartbeat",...}
                                                               v
                                                       pyserial (host)
                                                               |
        services/collector/src/serial_reader.read_serial_frames
        (open + watchdog + exponential backoff; yields RawCsiFrame | dict)
                                                               |
                                                               v
            apps/api/src/services/runtime.RuntimeState.publish_frame
                       /                |                 \
                      v                 v                  v
             InMemoryEventBus    SessionStore         BiorhythmEstimator
              (raw + derived)    (.jsonl + sqlite)    BaselineCalibrator
                                                          |
                                                          v
                                              services.dsp.features.derive_window
                                              (Hampel -> baseline-subtract ->
                                               detrend -> Butterworth band ->
                                               SNR-weighted RMS -> motion/
                                               occupancy/anomaly/quality)
                                                          |
                                                          v
                                                 DerivedWindow -> derived_bus
                                                          |
                          +-------------------------------+--------------+
                          |                                              |
                          v                                              v
              apps/api/src/api/routes (FastAPI)         apps/api/src/ws/live (WebSocket)
              REST surface for sessions,                pumps derived_window + raw_frame
              calibration, geometry,                    (rate-limited 30 Hz) to all
              diagnostics, devices                      subscribed clients
                          |                                              |
                          +----------------- HTTP / WS -------------------+
                                               |
                                               v
                                       apps/web (Next.js 16)
                                       lib/api.ts (rvFetch + connectLive)
                                       lib/use-live-stream.ts (rolling buffers)
                                       routes: /, /home, /raw, /3d, /devices-v2
```

### Module ownership (live)

| Path | Owns |
|---|---|
| `apps/api/src/main.py` | App composition + lifecycle |
| `apps/api/src/config.py` | `.env` loader, `Settings` dataclass, source-mode resolution |
| `apps/api/src/api/routes.py` | REST surface (`/devices`, `/sessions/*`, `/calibration/*`, `/diagnostics/*`, `/room/*`) |
| `apps/api/src/health/routes.py` | `/health` |
| `apps/api/src/ws/live.py` | `/ws/live` topic-multiplexed pump |
| `apps/api/src/services/runtime.py` | Per-frame pipeline orchestration, source-task lifecycle, calibration mediation |
| `apps/api/src/services/session_store.py` | SQLite (`sessions`, `events`, `room_geometry`) + per-session `.jsonl` (raw + derived) + Parquet export |
| `apps/api/src/services/link_stats.py` | Thread-safe rolling EMA rate, inter-arrival percentiles, RSSI/noise stats, firmware-heartbeat counters |
| `apps/api/src/logging_setup.py`, `http_logging.py` | Centralised logging, request-id middleware |
| `services/collector/src/parser.py` | Strict JSON line → `ParsedSerialMessage{csi|status|heartbeat}` / `RawCsiFrame` |
| `services/collector/src/serial_reader.py` | pyserial async iterator with watchdog + retry; emits frames, heartbeat dicts, `source_error` envelopes |
| `services/collector/src/replay.py` | JSONL replay generator (forces `source_mode=REPLAY`) |
| `services/collector/src/publisher.py` | `InMemoryEventBus` (asyncio fan-out, dead-queue eviction on `QueueFull`) |
| `services/collector/src/normalizer.py` | `enforce_source_mode(frame, expected)` validator |
| `services/dsp/src/preprocessing.py` | I/Q → amplitude / phase, edge-subcarrier drop, per-frame linear-phase removal |
| `services/dsp/src/filters.py` | Hampel, Butterworth (filtfilt), linear detrend, uniform resample, dB |
| `services/dsp/src/csi_ratio.py` | Adjacent-subcarrier complex ratio, breathing-band-aware top-K selection |
| `services/dsp/src/calibration.py` | `BaselineCalibrator` (Welford accumulator + Phase-B acceptance gates: frames, rate, RSSI σ, motion peak) |
| `services/dsp/src/biorhythm.py` | `BiorhythmEstimator` (CSI-ratio → Hampel → bandpass → FFT + ACF + harmonic check + stillness gate + EWMA tracker) |
| `services/dsp/src/features.py` | `derive_window(frames, calibrator, expected_rate_hz) -> DerivedWindow` |
| `services/dsp/src/motion.py`, `occupancy.py`, `summaries.py` | Threshold labels + `room_summary` packaging |
| `packages/protocol/python/aether_protocol/models.py` | Pydantic v2 strict models: `RawCsiFrame`, `DerivedWindow`, `RoomGeometry`, `ExperimentEvent`, `SourceMode` |
| `packages/protocol/typescript/src/index.ts` | TS mirror + `LinkDiagnostics` + `SubcarrierDiagnostics` interfaces |
| `packages/protocol/schemas/*.json` | JSON Schemas (validated by `tests/e2e/protocol-schema.test.mjs`) |
| `apps/web/lib/api.ts` | `rvFetch` HTTP wrapper, `connectLive` WebSocket helper (rAF-batched dispatch, exponential backoff) |
| `apps/web/lib/use-live-stream.ts` | React hook over `connectLive`, rolling window/frame buffers |
| `apps/web/lib/devlog.ts` | Tagged console logger + `ChunkLoadError` auto-reload |
| `apps/web/features/aether-console.tsx` | 2061-line legacy console (Live Room, Devices, Experiment Console, Data Explorer; Knowledge Base + Agent Console tabs render "unavailable" placeholders) |
| `apps/web/features/raw-sensor.tsx` | Link diagnostics card, frame inspector (TanStack virtual table), spectrogram canvas, subcarrier health |
| `apps/web/features/devices-v2.tsx` | Link state panel + drag-edit room geometry (2D floorplan + numeric form) |
| `apps/web/features/three-d/{three-d-page,scene}.tsx` | React-Three-Fiber scene gated on `geometry.is_complete`, real raw_frame-driven pulses |
| `apps/web/features/shell/app-shell.tsx` | Sidebar + topbar + `?embed=1` chrome-stripping mode + 5-s `/health` poller |
| `firmware/esp32-s3-rx/main/csi_capture.{c,h}` | `wifi_csi_set_rx_cb` -> bounded `rv_csi_packet_t` queue (depth 64); telemetry counters `s_dropped`, `uxQueueMessagesWaiting` |
| `firmware/esp32-s3-rx/main/serial_protocol.{c,h}` | Single-buffer JSON envelope writer; `fwrite+fflush` per CSI frame; 1 Hz `heartbeat` envelope |
| `firmware/esp32-s3-tx/main/app_main.c` | SoftAP + cadence-instrumented UDP sender |

### External dependency inventory (live)

Backend Python:
- `fastapi>=0.115`, `uvicorn[standard]>=0.30` — HTTP/WS server.
- `pydantic>=2.8` — wire-protocol model validation.
- `numpy>=2.0`, `scipy>=1.14` — DSP (`butter`, `filtfilt`, FFT, percentiles).
- `pyserial>=3.5` — RX board I/O. Imported lazily in `serial_reader` and `probe_serial.py`.
- `aiosqlite>=0.20`, `pyarrow>=17.0`, `polars>=1.8`, `duckdb>=1.1` — declared deps; only
  `sqlite3` (stdlib) + `pyarrow` (lazy in `export_raw_parquet`) are reached on the live
  path. polars / duckdb / aiosqlite are unused in any active import chain.
- Dev: `pytest>=8.3`, `pytest-asyncio>=0.24`, `httpx>=0.27`, `ruff>=0.6`, `mypy>=1.11`.

Frontend Node:
- `next@^16.2.6`, `react@^19`, `react-dom@^19` — framework.
- `uplot@^1.6.32` — `TrendChart`, `AmplitudeChart` (incremental `setData`).
- `@react-three/fiber@^9`, `@react-three/drei@^10`, `three@^0.169` — `/3d` scene; root
  also pins `three@^0.184` at workspace root for the landing page Three.js scene.
- `@tanstack/react-table@^8.21`, `@tanstack/react-virtual@^3.13` — frame inspector.
- `lucide-react@^0.468` — sidebar icons.

Firmware (ESP-IDF):
- `esp_wifi`, `esp_event`, `esp_netif`, `nvs_flash`, `freertos`, `esp_timer`, `lwip`
  (UDP socket APIs, `inet_addr`/`htons`).
- `sdkconfig.defaults`: `CONFIG_ESP_WIFI_CSI_ENABLED=y`,
  `CONFIG_ESP_CONSOLE_UART_BAUDRATE=921600`, RX/TX buffer counts.

Containers / orchestration:
- `docker-compose.yml` ships dev images (`python:3.12-slim`, `node:22-alpine`) but the
  README documents native execution; compose is convenience-only.

GitHub Actions: `.github/workflows/ci.yml` runs (a) `npm test` (protocol schema +
no-fake-data scan), (b) `pytest -q`, (c) `tsc --noEmit -w @aether/web` on push/PR.

---

## 4. SUBSYSTEM BREAKDOWN

### 4.1 Settings + dotenv loader (`apps/api/src/config.py`)
- **Identity:** `_load_dotenv_once()` + `get_settings()` -> frozen `Settings` dataclass.
- **Inputs:** `os.environ` (with `.env` at repo root layered in *behind* live env vars).
- **Outputs:** `Settings(source_mode, host, port, serial_port, baud, replay_path,
  data_dir, session_db, kb_root)`. `source_mode = REPLAY iff AETHER_REPLAY_PATH set,
  else LIVE`.
- **Side effects:** mutates `os.environ`; never overwrites a value already set.
- **Failure behavior:** `OSError` reading `.env` is swallowed silently.
- **Invariants:** dotenv loaded at most once per process; precedence shell > `.env`.

### 4.2 RuntimeState (`apps/api/src/services/runtime.py`)
- **Identity:** singleton instantiated in `main.py`; owns the source task and DSP state.
- **Inputs:** `RawCsiFrame` from collector / replay; `dict` heartbeat / source_error
  envelopes from `serial_reader`.
- **Outputs:** `latest_window`, `latest_raw`, `derived_bus`, `raw_bus`, `live_summary()`
  dict, `calibration_status()`, `subcarrier_diagnostics()`.
- **Side effects:** writes raw frames to JSONL + derived windows to JSONL via
  `SessionStore`; logs collector + DSP heartbeats every 100 frames / 50 windows.
- **Failure behavior:** live source-task exceptions logged via `logger.exception` then
  `running=False`; `start_replay`/`start_live` ignore call when an existing task is
  running (logs warning).
- **Key invariants:**
  - Window emission requires `len(_window_frames) >= 10`; `_window_frames`
    is a `deque(maxlen=40)`.
  - `expected_packet_rate_hz` starts at `DEFAULT_EXPECTED_PACKET_RATE_HZ=20.0`; flips to
    measured value once `link_stats.is_rate_stable()` (see 4.3) + obs > 0.5 Hz.
  - `last_source_error` is sticky until a frame succeeds; cleared on first successful
    `publish_frame`.

### 4.3 LinkStats (`apps/api/src/services/link_stats.py`)
- **Identity:** thread-safe rolling link telemetry.
- **Inputs:** `record_frame(ts_host_ns, rssi_dbm, noise_floor_dbm, first_word_invalid)`,
  `record_heartbeat(packets_seen, dropped, queue_depth)`.
- **Outputs:** `LinkSnapshot` (observed_rate_hz, p50/p90/p99/max/jitter inter-arrival ms,
  RSSI median/std, noise median, FWI ratio, firmware counters, rate_stable flag,
  last_frame_age, ad-hoc `notes[]` strings).
- **Invariants:**
  - `_DELTA_WINDOW=600` (~30 s at 20 Hz).
  - `_RATE_EMA_HALF_LIFE_S=5.0`.
  - Inter-arrival deltas < 0 or ≥ 5 s discarded as clock resets.
  - `is_rate_stable() := len(_deltas_ns) >= 30 and EMA > 0.5 Hz`.

### 4.4 SessionStore (`apps/api/src/services/session_store.py`)
- **Identity:** SQLite (`sessions`, `events`, `room_geometry`) + per-session JSONL on
  disk under `data/recordings/{session_id}.jsonl` and `.derived.jsonl`.
- **Inputs:** sessions / events / geometry CRUD; raw + derived frames from runtime.
- **Outputs:** session dicts, `RoomGeometry`, JSONL paths, optional Parquet export
  (`pyarrow` lazy import; `None` when `pyarrow` missing).
- **Side effects:** creates `data_dir / recordings`, `exports`, and parent of
  `session_db` on init. Writes JSONL via plain `open("a")` (no fsync).
- **Failure behavior:** `KeyError(session_id)` on lookup miss. Corrupted geometry row is
  silently replaced with default `RoomGeometry()` (broad except).
- **Invariants:** room geometry is single-row, keyed `id='current'` (geometry is
  installation-scoped, not session-scoped).

### 4.5 WebSocket pump (`apps/api/src/ws/live.py`)
- **Identity:** per-connection task pair (`pump_derived` + `pump_raw`).
- **Topics:** default `{"derived_window"}`. Client may send
  `{"type":"subscribe","topics":[...]}` to opt into `"raw_frame"`.
- **Outputs (server -> client):**
  - `hello { summary, available_topics:["derived_window","raw_frame"] }`.
  - `derived_window { window: DerivedWindow, summary: RoomSummary }`.
  - `raw_frame { frame: RawCsiFrame, derived: { amplitude[], phase[], subcarrier_count } }`
    rate-limited to 30 Hz per client (`_RAW_FRAME_MIN_INTERVAL_S = 1/30`).
  - `subscribed { topics: [...] }` ack.
- **Failure behavior:** shared `closed` event + `safe_send`; treats
  `WebSocketDisconnect` and Starlette/uvicorn "send after close" `RuntimeError`s as
  clean shutdowns. `asyncio.gather(..., return_exceptions=True)` so one pump's failure
  cannot cancel the other mid-write.
- **Observability:** `[ws] >> connect`, `[ws] hello sent`, periodic
  `[ws] sent N derived windows in 5.0s (X /s)`, `[ws] << disconnect`.

### 4.6 BaselineCalibrator (`services/dsp/src/calibration.py`)
- **Identity:** streaming Welford accumulator + acceptance gates.
- **Inputs:** per-frame amplitude vector + advisory `rssi_dbm`, `motion_score`.
- **Outputs:** baseline mean/std arrays, SNR weights `1/(std+eps)` normalised, top-K
  responsive subcarrier indices.
- **Failure / acceptance gates (Phase B):** rejects baseline when frames < 100, observed
  rate < 5 Hz, RSSI σ > 4 dB, or peak motion seen during window > 6.0; populates
  `last_rejection_reason` so the UI can explain.
- **Invariants:** subcarrier-count change mid-calibration resets all accumulators.

### 4.7 derive_window (`services/dsp/src/features.py`)
- **Identity:** per-window feature extractor.
- **Pipeline (in order):** `frames_to_amplitude_matrix` → `drop_edge_subcarriers(0.06)`
  → `hampel_filter_columns(window=ceil(0.175*sample_rate))` → mean/std stash → baseline
  subtract (or per-window centring) → `detrend_columns` → `butter_filter_columns(low=
  0.05 Hz, high=min(5 Hz, 0.4*fs), order=3)` → SNR-weighted RMS over responsive subset
  (when calibrated) → phase via `frames_to_phase_matrix` (np.unwrap axis=0) +
  `remove_linear_phase_per_frame` → `motion_score = 0.85*amp + 0.15*phase`.
- **Output:** `DerivedWindow` (subcarrier_count is post-edge-trim).
- **Quality score:** weighted sum 0.40·valid_ratio + 0.30·packet_quality +
  0.15·rssi_stability + 0.15·jitter_penalty, clamped [0,1].
- **Invariants:** rejects empty frame list (`ValueError`); returns `_empty_window` when
  amplitude matrix is empty.

### 4.8 BiorhythmEstimator (`services/dsp/src/biorhythm.py`)
- **Identity:** research-only respiration / fidget / "HR proxy" estimator.
- **Pipeline:** complex CSI buffer (max 24 s) → optional `csi_ratio_magnitude` (falls
  back to amplitude when ratio std ≈ 0) → top-K subcarrier-pair selection by
  breathing-band energy ratio → mean → Hampel → uniform-grid resample → Butterworth
  bandpass 0.05 Hz–min(3, 0.45·fs) → rFFT peak with harmonic prominence + ACF lag
  cross-check → confidence-weighted EWMA tracker → stillness gate.
- **Output:** `BiorhythmReading` with FFT BPM, ACF BPM, tracked BPM, harmonic
  prominence, fidget energy ratio, `stillness_gated`, `looks_like_respiration_harmonic`,
  `signal_path` ∈ {"ratio","amplitude"}.
- **Stillness gate thresholds:** `MOTION_GATE_CALIBRATED=1.5`,
  `MOTION_GATE_UNCALIBRATED=5.0`.
- **Confidence rules:** halve confidence when |FFT_BPM − ACF_BPM| > tolerance
  (`RESP=5`, `HEART=8` BPM); cap heart-band confidence at 0.2 when its peak is
  1.85–2.15× the respiration peak (probable harmonic).
- **NOTE:** runtime mounts the reading onto `DerivedWindow` unconditionally; the
  documented "research-only" gate is enforced *in the UI* by confidence threshold, not
  by stripping fields. `services/dsp/src/respiration.mark_respiration_experimental` is
  defined but never called (see §10).

### 4.9 SerialReader (`services/collector/src/serial_reader.py`)
- **Identity:** async iterator wrapping pyserial in a watchdog/backoff loop.
- **Inputs:** `port`, `baud`, `session_id`.
- **Outputs:** yields `RawCsiFrame` (csi messages), `dict` (heartbeat envelopes),
  `dict {"type":"source_error","kind":...,"error":...}` on `SerialException`/`OSError`.
- **Constants:** `READ_STALL_SECONDS=10.0`, `INITIAL_RETRY_SECONDS=1.0`,
  `MAX_RETRY_SECONDS=30.0`, exponential backoff 2×.
- **Invariants:** never raises in steady state; only exits on task cancellation.

### 4.10 RX firmware
- **`csi_capture.c::csi_rx_cb`** copies bounded `len ≤ RV_MAX_CSI_BYTES=384` bytes into
  a 64-deep `xQueue` from Wi-Fi-task context; increments `s_dropped` on `xQueueSend !=
  pdTRUE`.
- **`app_main.c::serial_task`** drains the queue with a 500 ms timeout, calls
  `rv_serial_write_csi`, and emits a `heartbeat` envelope every 1 s with
  `(packets_seen, rv_csi_dropped_count(), rv_csi_queue_pending(), uptime_us)`.
- **`serial_protocol.c::rv_serial_write_csi`** renders the entire JSON envelope into a
  2560-byte static buffer with bounded `snprintf`, emits via single `fwrite+fflush`.
  Pre-rewrite: ~390 separate `printf`s per frame; post-rewrite: 1.
- **Pinning:** `udp_sink_task` core 0 (PRO_CPU, alongside Wi-Fi+LWIP), `serial_task`
  core 1 (APP_CPU).

### 4.11 TX firmware
- **`udp_sender_task`** transmits `rv_tx_packet_t {magic, sequence, device_time_us,
  payload[96]}` every `RV_TX_PACKET_INTERVAL_MS=50`. Initially broadcasts to
  `192.168.4.255`; switches to unicast when an RX hello (`"rv-rx-ready"`) is received.
- **Cadence instrumentation:** every 200 packets logs measured min / avg / max
  inter-packet interval µs (Phase A diagnostic for the 6 Hz vs 20 Hz mismatch tracked in
  `PROBLEMS.md` §1.1).

---

## 5. DATA FLOWS

### 5.1 LIVE source → derived window → UI
```
ESP32 RX (UART JSON @921600)
  -> pyserial readline (asyncio.to_thread, 1 s timeout, 10 s stall watchdog)
  -> services/collector/src/parser.parse_serial_line
       VALIDATION: JSON object, type∈{csi,status,heartbeat}, RawCsiFrame Pydantic
  -> RuntimeState.publish_frame
       MUTATES: latest_raw, last_frame_ts_host_ns, _window_frames (deque[40]),
                _frames_seen, last_source_error (cleared)
       SIDE EFFECT: SessionStore.append_raw_frame -> data/recordings/<sid>.jsonl
       FAN-OUT: raw_bus.publish(frame), link_stats.record_frame
       BIORHYTHM: BiorhythmEstimator.update (24 s window)
       CALIBRATION: BaselineCalibrator.feed (when is_calibrating)
  -> when len(_window_frames) >= 10:
       derive_window(...) -> DerivedWindow
       SIDE EFFECT: SessionStore.append_derived_window
       FAN-OUT: derived_bus.publish(window)
  -> ws/live.pump_derived
       VALIDATION: topics filter
       OUTPUT: send_json {derived_window, summary} per subscriber (rate-logged 5 s)
  -> apps/web/lib/use-live-stream
       MUTATES: windows[] (rolling, default 160), summary, status
  -> apps/web/features/aether-console (or raw-sensor / three-d / devices-v2)
```

### 5.2 REPLAY source → derived window
```
data/recordings/<sid>.jsonl
  -> services/collector/src/replay.replay_jsonl (forces source_mode=REPLAY)
  -> RuntimeState.start_replay run() loop
       throttles to packet_rate_hz=20.0 via asyncio.sleep(1/20)
  -> publish_frame ... (identical from here)
```

### 5.3 Raw frame fan-out (UI opt-in)
```
RuntimeState.publish_frame
  -> raw_bus.publish(frame)
  -> ws/live.pump_raw
       FILTER: topics contains "raw_frame"
       RATE LIMIT: server-side 30 Hz/client (_RAW_FRAME_MIN_INTERVAL_S)
       ENRICH: iq_array_to_amplitude/phase computed on send
       OUTPUT: {raw_frame, frame, derived:{amplitude,phase,subcarrier_count}}
  -> apps/web/lib/use-live-stream.frames[] (rolling, default 200)
```

### 5.4 Calibration
```
POST /calibration/baseline {duration_seconds}
  -> RuntimeState.begin_calibration (rejects if no live frames yet)
  -> BaselineCalibrator.begin (clears mean/m2/rssi_samples)
  -> publish_frame loop feeds calibrator with (amp, ts, rssi, motion)
  -> calibrator.feed evaluates Phase-B acceptance once frames>=100 AND elapsed>=target
  -> next derive_window picks up baseline_calibrated=True
  -> /calibration/baseline GET returns {is_calibrated, accepted, last_rejection_reason}
```

### 5.5 Sessions (REST-only flow)
```
POST /sessions              -> SessionStore.create_session (uuid4, sqlite insert)
POST /sessions/{id}/start   -> SessionStore.start_session + RuntimeState.start_live|replay
POST /sessions/{id}/stop    -> RuntimeState.stop + SessionStore.stop_session
POST /sessions/{id}/events  -> append ExperimentEvent to events table
GET  /sessions/{id}/summary -> walk JSONL + sqlite events; counts only
GET  /sessions/{id}/frames  -> read raw JSONL with from_ns/to_ns/limit (cap 2000)
GET  /sessions/{id}/frames/latest?n -> tail-N read (cap 500)
GET  /sessions/{id}/export  -> SessionStore.export_session_report (.report.md +
                               optional Parquet via pyarrow lazy import)
```

### 5.6 Room geometry
```
GET  /room/geometry  -> SessionStore.get_room_geometry (default RoomGeometry() if
                        no row OR unparseable JSON)
PUT  /room/geometry  -> validates RoomGeometry payload, stamps updated_ns,
                        UPSERT id='current' in room_geometry table
```

---

## 6. STATE MODEL

| Location | Kind | Owner | Read pattern | Write pattern | Concurrency |
|---|---|---|---|---|---|
| `RuntimeState` instance | in-memory mutable | `main.py` constructs once | Routes + WS read directly | `publish_frame` writes from source task | Single asyncio loop; WS `pump_*` are sibling tasks reading attributes; no locks |
| `BaselineCalibrator._mean / _m2 / _rssi_samples` | in-memory mutable | `RuntimeState._calibrator` | `snapshot()` / `status()` | `feed()` from `publish_frame` | Single-writer (asyncio loop) |
| `BiorhythmEstimator._timestamps / _complex_csi` (`maxlen=4096`) | in-memory rolling | `RuntimeState._biorhythm` | `latest()` per window emit | `update()` per frame | Single-writer |
| `LinkStats` deques (`_deltas_ns`, `_rssi`, `_noise`) | in-memory rolling | `RuntimeState.link_stats` | Routes/WS via `snapshot()` | `record_frame`, `record_heartbeat` | `threading.Lock` (only true cross-thread state in the API) |
| `InMemoryEventBus._subscribers` | in-memory | `raw_bus`, `derived_bus` | per-subscriber `asyncio.Queue` | `publish_nowait` evicts on `QueueFull` | asyncio loop |
| `SessionStore` SQLite at `data/aether.sqlite` | persistent | filesystem | new `sqlite3.connect` per call | per-call connection auto-commit | sqlite3 default (serialised; no WAL set) |
| `data/recordings/{sid}.jsonl` + `.derived.jsonl` | persistent append-only | filesystem | line-by-line streaming reads | `open("a")` per frame, no fsync | single writer (the source task) |
| `data/exports/{sid}.report.md` + `.parquet` | persistent | filesystem | one-shot read | one-shot write on `/export` |
| Frontend `useLiveStream` `windows[]`, `frames[]`, `summary`, `status` | React state | per-component | hooks consumers | rAF-batched dispatch from WebSocket | single React render loop |
| Browser localStorage / cookies | none used | n/a |
| ESP32 RX `s_csi_queue` (xQueueCreate(64)) | RTOS queue | csi_capture | `serial_task` xQueueReceive | `csi_rx_cb` xQueueSend (no-block; counts drops) | FreeRTOS-safe |

Concurrency safety:
- The asyncio path is single-loop: there are no locks because there is one writer per
  attribute. `LinkStats` is the exception; it explicitly uses `threading.Lock` because
  `pyserial.readline` runs in a worker thread via `asyncio.to_thread` and `record_frame`
  is called from the asyncio task thread, while `snapshot()` is called from route
  handlers — practically the same loop, but the `to_thread` boundary justifies the lock.
- `SessionStore` opens a fresh connection per call (`sqlite3.connect`); fine for
  current write rate (~20 Hz) on a single host.
- `InMemoryEventBus` evicts subscribers whose queue is full rather than blocking the
  publisher. This means a slow/disconnected WS client will be dropped silently.

---

## 7. RUNTIME BEHAVIOR

- **Triggers:**
  - HTTP request (`uvicorn` → FastAPI route).
  - WebSocket connect on `/ws/live` (one task pair per client, lives until disconnect).
  - Source task (one `asyncio.Task` per `start_live`/`start_replay`); replaced when
    `stop()` cancels and the next `start_*` runs.
- **Concurrency model:** asyncio single loop (uvicorn default). `pyserial.readline`
  off-loaded to a worker thread via `asyncio.to_thread`. `LinkStats` mutex bridges that
  boundary.
- **Load behavior:**
  - Backpressure on `InMemoryEventBus`: `asyncio.Queue` with `maxsize=1024`; on
    `QueueFull` the publisher discards the offending subscriber from the set (no
    blocking, no retry).
  - `pump_raw` enforces 30 Hz/client max regardless of link rate.
  - DSP per-window cost: O(T·S) for an `T≈10`–40, `S≈32`–64 amplitude matrix; SciPy
    filtfilt dominates. No batch I/O.
  - Disk write: append per-frame JSONL with no fsync; OS page cache absorbs at 20 Hz.
- **Failure / recovery:**
  - Serial open / readline failure: `serial_reader` yields a `source_error` envelope;
    `RuntimeState` records `last_source_error{,_kind,_at_ns}`; the reader retries with
    1 → 30 s exponential backoff.
  - WebSocket send after close: `safe_send` traps `WebSocketDisconnect` and
    `RuntimeError`, sets `closed` event, both pumps unwind cleanly.
  - DSP per-frame exception: not caught — would propagate into the source task and
    crash it (logged via `logger.exception` in `start_live`'s outer try/except, then
    `running=False`).
  - Calibration rejection is non-fatal: surfaced via `calibrator.last_rejection_reason`;
    runtime continues without baseline-calibrated motion.
- **Observability:**
  - Tagged log prefixes: `[boot]`, `[http]`, `[ws]`, `[route]`, `[runtime]`.
  - `[runtime] collector heartbeat` every 100 frames (frames, windows, buffered, obs Hz,
    expected Hz, p50/p99 ms, drops).
  - `[runtime] dsp heartbeat` every 50 windows.
  - `[ws] sent N in 5.0s` per-connection rate line.
  - `[http]` request id + duration, WARN above 750 ms.
  - Frontend: `lib/devlog.ts` emits `[rv:api|ws|state|error|boot]` to console; opname
    state-machine throttles repeated failures to one line (and one "recovered" line).
  - Firmware: TX cadence log every 200 packets; RX heartbeat envelope every 1 s;
    queue-overflow counter via `rv_csi_dropped_count()`.
- **Gaps:** no metrics endpoint; no structured-JSON log emitter (PROBLEMS.md §5.3); no
  pre-commit gates (PROBLEMS.md §5.1); no frontend test runner (PROBLEMS.md §5.2).

---

## 8. CONFIGURATION MANIFEST

| Key | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `AETHER_API_HOST` | string | no | `127.0.0.1` | uvicorn bind host (read in `Settings`; not enforced by uvicorn unless passed on CLI) |
| `AETHER_API_PORT` | int | no | `8000` | uvicorn bind port (same caveat) |
| `AETHER_SERIAL_PORT` | string \| empty | yes for LIVE | none | RX board COM port (e.g. `COM10`, `/dev/ttyUSB0`); blank ⇒ `serial_port=None` |
| `AETHER_BAUD` | int | no | `115200` (config.py) / `921600` (.env.example post-2026-05-10 firmware) | UART baud (must match `CONFIG_ESP_CONSOLE_UART_BAUDRATE`) |
| `AETHER_REPLAY_PATH` | string \| empty | yes for REPLAY | none | When set, `source_mode=REPLAY`; consumed in `start_replay` |
| `AETHER_DATA_DIR` | path | no | `./data` | Root for `recordings/`, `exports/`, sqlite |
| `AETHER_SESSION_DB` | path | no | `${data_dir}/aether.sqlite` | SQLite path |
| `AETHER_KB_ROOT` | path | no | `./docs` | KB ingest root (only used by unwired `services/kb/`) |
| `AETHER_LOG_LEVEL` | enum | no | `INFO` | Root logger level (`DEBUG` enables per-frame chatter) |
| `NEXT_PUBLIC_AETHER_API` | URL | no | `http://127.0.0.1:8000` | Browser HTTP base in `lib/api.ts` |
| `NEXT_PUBLIC_AETHER_WS` | URL | no | `ws://127.0.0.1:8000/ws/live` | Browser WS URL |
| `NODE_ENV` | string | no | platform default | `lib/devlog.ts` gates the `ChunkLoadError` auto-reload to non-production |

Source mode resolution: `SourceMode.REPLAY iff AETHER_REPLAY_PATH else SourceMode.LIVE`
(`config.py:69`).

`.env` precedence: shell-set env > `.env` file at repo root > defaults (`config.py:44`).

Firmware sdkconfig (RX): `CONFIG_ESP_WIFI_CSI_ENABLED=y`,
`CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM=16`, `CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM=64`,
`CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM=32`, `CONFIG_LWIP_SO_REUSE=y`,
`CONFIG_ESP_CONSOLE_UART_BAUDRATE=921600`, `CONFIG_ESP_CONSOLE_UART_TX_BUFFER_SIZE=2048`.
Firmware constants: `RV_TX_PACKET_INTERVAL_MS=50`, `RV_TX_CHANNEL=6`, `RV_TX_SSID=AETHER_V0`,
queue depth 64, `RV_MAX_CSI_BYTES=384`, `RV_SERIAL_BUFFER_BYTES=2560`.

CORS: `apps/api/src/main.py` allows only `http://127.0.0.1:3000` and
`http://localhost:3000`.

---

## 9. INTEGRATION SURFACE

### 9.1 Exposed REST contracts (FastAPI)

| Method + path | Body | Response shape | Source |
|---|---|---|---|
| `GET /health` | — | `{status,source_mode,service}` | `health/routes.py` |
| `GET /devices` | — | `{source_mode, tx:{role,status}, rx:{role,status,serial_port,baud,observed/expected_packet_rate_hz,expected_rate_source,firmware_dropped,firmware_queue_depth,last_frame_age_s,last_error,last_error_kind}, host:{api}}` | `routes.py:devices` |
| `POST /sessions` | `{protocol,notes?,consent?}` | session row | `routes.py:create_session` |
| `GET /sessions` | — | session row[] | `routes.py:list_sessions` |
| `GET /sessions/{id}` | — | session row | `routes.py:get_session` |
| `POST /sessions/{id}/start` | — | session row + side-effect `start_live|replay` | `routes.py:start_session` |
| `POST /sessions/{id}/stop` | — | session row + side-effect `RuntimeState.stop` | `routes.py:stop_session` |
| `POST /sessions/{id}/events` | `{event_type,label?,notes?,metadata?}` | `ExperimentEvent.model_dump` | `routes.py:add_event` |
| `GET /sessions/{id}/summary` | — | `{session,raw_frame_count,derived_window_count,event_count,latest_window,...}` | `session_store.summarize_session` |
| `GET /sessions/{id}/frames?from_ns&to_ns&limit≤2000` | — | `{count,frames:RawFrame[]}` | `session_store.read_raw_frames` |
| `GET /sessions/{id}/frames/latest?n≤500` | — | tail-N `{count,frames:RawFrame[]}` | same |
| `GET /sessions/{id}/export` | — | `{report_path}` | `session_store.export_session_report` |
| `GET /room/summary` | — | `room_summary.v1` (or `{status:"warming_up"}`) | `runtime.live_summary` |
| `GET /calibration/baseline` | — | `CalibrationStatus` | `BaselineCalibrator.status` |
| `POST /calibration/baseline` | `{duration_seconds}` | `CalibrationStatus` (409 if no live frames) | `runtime.begin_calibration` |
| `DELETE /calibration/baseline` | — | reset | `runtime.reset_calibration` |
| `POST /calibration/baseline/cancel` | — | | `runtime.cancel_calibration` |
| `GET /diagnostics/link` | — | `link_diagnostics.v1` | `LinkStats.snapshot` + RSSI-implied distance |
| `GET /diagnostics/subcarriers` | — | `subcarrier_diagnostics.v1` | `runtime.subcarrier_diagnostics` |
| `GET /room/geometry` | — | `room_geometry.v1` + `is_complete` + `rssi_implied_distance_m` | `session_store.get_room_geometry` |
| `PUT /room/geometry` | `RoomGeometry` | echo + `is_complete` | `session_store.set_room_geometry` |

### 9.2 Exposed WebSocket contract (`/ws/live`)

- Server → client message types: `hello`, `derived_window`, `raw_frame`, `subscribed`.
- Client → server messages: `{"type":"subscribe","topics":["derived_window","raw_frame"]}`.
- All payloads validated against `aether_protocol` Pydantic models on the server side
  before being JSON-serialised; the client side does no schema validation.

### 9.3 Wire schemas (canonical)

- `csi_frame.v1` — `packages/protocol/schemas/csi_frame.schema.json` mirrored by
  `aether_protocol.RawCsiFrame` and `@aether/protocol.RawCsiFrame`. Strict
  (`additionalProperties:false`); int8 IQ values validated.
- `derived_window.v1` — `derived_window.schema.json` mirrored by
  `aether_protocol.DerivedWindow`. Bounded fields:
  `occupancy_score∈[0,1]`, `quality_score∈[0,1]`, `respiration_confidence∈[0,1]|null`,
  `motion_score>=0`, `anomaly_score>=0`.
- `experiment_event.v1` — fixed `event_type` enum (12 values).
- `room_geometry.v1` — every position field nullable until operator entry.
- `link_diagnostics.v1`, `subcarrier_diagnostics.v1` — declared in TS only
  (`packages/protocol/typescript/src/index.ts`); no JSON-Schema file.

### 9.4 External dependencies (live consumers)

- ESP32-S3 boards over USB-CDC: producer (RX) speaks the line-delimited JSON dialect;
  consumer (host pyserial) parses via `parser.parse_serial_line`. No back-channel except
  the documented (but not currently used) RX→TX `"rv-rx-ready"` UDP hello.
- File system at `AETHER_DATA_DIR`: read/write JSONL + sqlite + parquet.
- Browser at `:3000` over CORS-allowed origin.
- Google Fonts (Inter, JetBrains Mono, Lora) via `next/font` (build-time fetch + runtime
  preconnect link in `app/layout.tsx`). The only outbound network beyond localhost.

---

## 10. CONSTRAINTS AND FRAGILITY POINTS

| Location | Observed constraint / fragility | Implication |
|---|---|---|
| `apps/api/src/main.py:38-46` | CORS allow-list pinned to `127.0.0.1:3000` and `localhost:3000` | Any change to `AETHER_WEB_PORT` requires editing source — env var is read elsewhere but not here |
| `apps/api/src/api/routes.py:27-29` (`_TX_EFFECTIVE_DBM=17`, `_PL_1M_DB=40`, `_PL_EXPONENT=3`) | RSSI→distance helper hardcoded | Indoor variability +/- 50%; flagged as "sanity check" not measurement (test confirms it refuses below noise floor) |
| `apps/api/src/services/runtime.py:28` `DEFAULT_EXPECTED_PACKET_RATE_HZ=20.0` | Hardcoded TX cadence assumption | LinkStats adopt-observed swap depends on this; before swap, quality_score is biased low if the link runs at 6 Hz (PROBLEMS §1.1) |
| `apps/api/src/services/runtime.py:282-292` `start_replay` `packet_rate_hz=20.0` and `asyncio.sleep(1/20)` | Replay always plays at 20 Hz regardless of source | Replay timing is a fiction; `expected_rate_source="replay_configured"` makes that explicit |
| `apps/api/src/services/session_store.py:45-71` SQLite `_init_db` | No migrations; columns are additive only | Schema change requires manual file delete; all sessions live in one db |
| `apps/api/src/services/session_store.py:213` JSONL append without fsync | Crash mid-write may yield a partial line | `read_raw_frames` skips `JSONDecodeError` lines silently — corruption is non-fatal but invisible |
| `apps/api/src/ws/live.py:208` `asyncio.gather(..., return_exceptions=True)` | Hides per-pump errors after first message | Diagnosing a pump failure requires turning on DEBUG; no metric exposed |
| `apps/api/src/ws/live.py:48` `_RAW_FRAME_MIN_INTERVAL_S=1/30` | Server-side raw-frame rate limit | UI cannot demand more than 30 Hz raw even if link is faster; OK because spectrograms and 3D scene work fine at 30 Hz, but unstated in the protocol surface |
| `services/dsp/src/features.py:62-63` `MOTION_PHASE_WEIGHT=0.15` | Hardcoded weighting | Marked conservative pending CFO/STO calibration maturity |
| `services/dsp/src/features.py:230` occupancy fallback scale `18.0` | Magic number for uncalibrated occupancy | Tests assert ≤ 0.5 in calibrated case; uncalibrated scaling is heuristic |
| `services/dsp/src/calibration.py:41-43` `_BASELINE_REJECT_RSSI_STD_DB=4.0`, `_BASELINE_REJECT_RATE_FLOOR_HZ=5.0`, `_BASELINE_MIN_FRAMES=100` | Acceptance gates fixed | Tests rely on these exact values; tuning requires updating tests in lockstep |
| `services/dsp/src/biorhythm.py:75-76` `MOTION_GATE_CALIBRATED=1.5`, `MOTION_GATE_UNCALIBRATED=5.0` | Stillness thresholds fixed | Coupled to motion_score scale; if motion_score units change these silently mis-gate |
| `services/dsp/src/respiration.py` `mark_respiration_experimental` | Defined but never imported anywhere in the live system (verified by grep — only referenced in `docs/PLAN_3D_RAW_CALIBRATION.md` as a known gap) | Respiration fields ride to the UI unconditionally; the "research-only" gate is enforced UI-side by confidence threshold (`>=0.30`/`>=0.45`) only |
| `services/collector/src/serial_reader.py:50` `pyserial` lazy import | Import error at first start_live, not at module load | Diagnostic delayed until first session start |
| `services/collector/src/publisher.py:18-22` `QueueFull` evicts subscriber silently | Slow/disconnected WS clients vanish without log | Hard to detect "why is my UI stale" — no observability on the bus |
| `apps/web/lib/api.ts:13-14` API base / WS URL fall back to localhost | Same caveat as CORS — port change breaks live stream | |
| `apps/web/features/aether-console.tsx` 2061 LOC | Single monolith; PROBLEMS §2.4b notes it still owns its own internal nav/topbar | Splitting tracked in `docs/PLAN_3D_RAW_CALIBRATION.md` §4.2 |
| `apps/web/features/aether-console.tsx:43` (Knowledge Base, Agent Console tabs) | Render "unavailable" banners | UI is wired to non-existent `/agent/ask` and `/kb/search` routes |
| `firmware/esp32-s3-rx/main/csi_capture.c:66` queue depth 64 | Drops on overflow | `s_dropped` counter surfaces, but no recovery path on the ESP — host must drain |
| `firmware/esp32-s3-rx/main/serial_protocol.c:40` `RV_SERIAL_BUFFER_BYTES=2560` static buffer | Single-writer assumption | Only `serial_task` calls `rv_serial_write_*`; concurrent caller would corrupt the buffer |
| `firmware/esp32-s3-rx/main/app_main.c:20` SSID `AETHER_V0` and PSK hardcoded | Two-board pairing is implicit | Multiple bracket pairs in the same RF environment will associate randomly |
| `data/aether.sqlite` and `data/radio_vision.sqlite` both present in `data/` | Two artefacts on disk; `radio_vision.sqlite` is not referenced by the code today | Likely leftover from rename; safe to delete but should be confirmed before doing so |

Inactive / unreachable code retained in tree (non-fatal, but distorts a naïve grep):
- `services/agent/` — `RoomAgent`, `RoomTools` defined and tested in isolation; **no
  FastAPI route imports them**. Confirmed by searching the live API for `RoomAgent` /
  `RoomTools` — only the agent's own modules + tests reference them. PROBLEMS §2.1.
- `services/kb/` — same pattern; no `/kb/search` route exists. PROBLEMS §2.2.
- `packages/ui/design-system.ts` — exported tokens; only referenced by an archived doc;
  not imported by any active web file (the frontend uses CSS variables in
  `apps/web/app/globals.css`).
- `services/dsp/src/respiration.mark_respiration_experimental` — never imported.
- `data/recordings/*.derived.jsonl` (3 sample sessions) — committed for replay smoke
  testing; not referenced by active code paths.

---

## 11. AGENT REASONING SCAFFOLD

### Open questions raised by current state
1. **Live packet rate is ~6 Hz, target 20 Hz** (PROBLEMS §1.1). `LinkStats` and TX
   cadence logging are now in place; the open question is *which* of {firmware bug,
   host serial bottleneck, Wi-Fi channel contention} is responsible. Until resolved,
   `quality_score` and motion thresholds operate on an unverified rate assumption.
2. **CSI-ratio path coverage in production.** `_build_signal_matrix` falls back to
   amplitude when ratio variance is degenerate. Synthetic tests demonstrably trigger the
   fallback (`test_signal_path_falls_back_to_amplitude_for_uniform_subcarriers`). What
   fraction of *real* hardware windows take the ratio vs amplitude path? `signal_path`
   is on `DerivedWindow` but no route surfaces a histogram.
3. **Calibration acceptance false-positive rate.** Gates fire at fixed thresholds
   (`_BASELINE_REJECT_*` constants); there is no record of how often empty-room baselines
   are rejected in practice, nor of the false-rejection rate.
4. **Heart-rate-proxy field semantics.** Reading is gated UI-side at 0.45 confidence
   but always serialised; the harmonic-suppression and ACF-disagreement halving are
   correct but lack ground-truth labelling.
5. **Geometry vs RSSI sanity-check loop.** `rssi_implied_distance_m` is surfaced
   alongside operator-entered TX/RX positions, but there is no UI affordance comparing
   the two — and no test that this comparison is even computable.

### Subsystems flagged as candidates for replacement / simplification
- **`apps/web/features/aether-console.tsx` (2061 LOC).** Strongly coupled to its own
  internal navigation despite the new `AppShell` already wrapping it. Signal: the file
  reimplements sidebar sections (`navSections` constant) overlapping with `app-shell.tsx`.
  Fragmenting along the existing `PageName` axis is the obvious split.
- **`InMemoryEventBus.publish` "drop subscriber on full queue" policy.** Signal: zero
  observability when a UI is dropped. Replacing with bounded back-pressure + a metric
  would clarify the "stale UI" failure mode.
- **`SessionStore.read_raw_frames(latest=True)` "tail by walking the whole file"
  implementation.** Signal: O(N) per request for a file that grows for the duration of
  the session. With > tens of thousands of frames per session this becomes a UI hitch.
  Either a length index or seeking from end-of-file would suffice.
- **Two SQLite files (`aether.sqlite` and `radio_vision.sqlite`).** Signal: only one is
  referenced. Decide / delete.
- **`scripts/no_nonreal_data_check.mjs`.** Token-list check; signal: depends on naming
  conventions surviving refactors. A semantic check (forbid certain imports / call
  sites) would be more durable. Low priority — current implementation is honest.
- **`services/kb/` and `services/agent/` scaffolding.** Signal: built, tested, never
  reached. Either wire them per PROBLEMS §2.1/§2.2 fix sketch or delete.

### Integration boundaries — stability ranking
- **Stable:** Pydantic↔JSON-Schema↔TypeScript triplet for wire types is enforced by
  `tests/e2e/protocol-schema.test.mjs`; drift is detectable. WebSocket message envelope
  (`type` + `topic` model) is internal-stable.
- **Moderately stable:** REST surface — schemas are not enforced contract-test-style;
  `link_diagnostics.v1` and `subcarrier_diagnostics.v1` exist only in TS (no JSON Schema
  file).
- **Brittle:** Serial-line dialect from RX firmware. `parser.parse_serial_line` accepts
  multiple field-name aliases (`raw_iq_int8|data`, `rssi_dbm|rssi`, `noise_floor_dbm|noise_floor`)
  — the loosened schema masks any drift between firmware and host.
- **Brittle:** TX↔RX pairing implicit via fixed SSID `AETHER_V0`. No firmware version
  handshake.
- **Brittle:** the host's `AETHER_BAUD` must match firmware `CONFIG_ESP_CONSOLE_UART_BAUDRATE`;
  mismatch produces unreadable bytes, not a clean error. Documented in `sdkconfig.defaults`
  comment; not enforced.

### Information missing from this document an agent might need
- **Hardware-validated packet rate / CSI subcarrier count.** The code says 20 Hz / ~64
  subcarriers; PROBLEMS §1.1 says 6 Hz observed. Look in `data/recordings/*.jsonl` for
  empirical distributions; check `[runtime] collector heartbeat` lines in any running
  log; run `scripts/validate_accuracy.py` against a recording.
- **Empirical motion / occupancy thresholds.** Code constants are guesses tuned during
  development. Source of truth: ground-truth labels via `ExperimentEvent` rows in
  `data/aether.sqlite` keyed by `event_type` (`person_entered`, `wave_hand`, etc.); none
  shipped here.
- **Protocol payload calibration of `payload_len` vs subcarrier_count.** `RawCsiFrame.raw_iq_int8`
  is `payload_len` int8 values; no fixed length. Check `csi_capture.c::RV_MAX_CSI_BYTES=384`
  and the actual `data->len` distribution off-board.
- **Full surface of `apps/web/features/aether-console.tsx`** (only first 120 lines were
  read for this audit). Look at section headers, sub-pages, and which APIs each subpage
  hits — the routes table in §9.1 is from the FastAPI side, not the consumers' side.
- **Lint / typecheck baselines.** Local `npm run lint` and `tsc --noEmit -w @aether/web`
  against the current tree have not been confirmed clean here.
- **`docker-compose.yml` parity.** It exists but the README documents native execution;
  whether it boots cleanly today is unverified.

### Research vectors worth evaluating
- **CSI cleaning beyond CSI-ratio:** PhaseFi-style multi-receiver phase detrend (multi-RX
  or multi-antenna), conjugate multiplication (CSI-conj). Current pipeline already
  implements `remove_linear_phase_per_frame`; phase weight is intentionally low.
- **Vital-sign extraction surveys:** WiPhone, FullBreathe, RT-Fall — any approach
  that does not assume LOS-Fresnel placement. Current implementation has hard
  geometric assumptions (subject in or near LOS).
- **Occupancy classification with one TX-RX pair:** Wi-Vi, FreeSense — though the
  `CLAUDE.md` honesty rules constrain claims to motion / occupancy / signal quality.
- **WebSocket back-pressure libraries:** `aiostream`, `anyio` memory-channels for a
  bounded-bus replacement.
- **JSON-Schema-driven contract tests:** `pact-python`, `schemathesis` against the
  FastAPI app to lock the REST surface against the schemas in `packages/protocol/schemas/`
  the way `tests/e2e/protocol-schema.test.mjs` already locks the TS side.
- **Structured-logging stacks:** `structlog`, `python-json-logger` — a small wrapper
  around `logging_setup.configure_logging` (PROBLEMS §5.3 fix sketch).
- **CSI sampling rate fixes:** ESP-IDF `wifi_promiscuous_filter`, channel pinning,
  `cwb` width 20-vs-40, RX/TX power tuning.
- **Multi-RX position estimation:** TDoA with two RX boards is the textbook upgrade
  path beyond what one bracket pair can sense (PROBLEMS §6).

### Decision triggers (observable in code today)
- **Packet rate stays < 10 Hz after firmware reflash:** firmware bottleneck disproven →
  reconsider the host serial path (`asyncio.to_thread(serial.readline)` in
  `serial_reader.py`), e.g. switch to `inWaiting()` polling or an ASIO native stream.
- **`firmware_dropped` > 0 in heartbeats:** queue overflow on the ESP — implies host is
  draining slower than firmware emits even with the 921600 lift; revisit UART buffer
  config or move the collector off Windows.
- **`first_word_invalid_ratio` > 0.05 sustained:** RX antenna / radio-front-end issue
  rather than serial path; warrants a hardware swap test.
- **`baseline_calibrated=False` consistently after an empty-room calibration:** check
  `last_rejection_reason`; if rate-floor failures dominate, return to packet-rate
  triage above.
- **`inter_arrival_p99_ms / inter_arrival_p50_ms > 4`:** heavy jitter — reconsider
  channel selection (current TX channel hardcoded to 6; nothing scans for quiet
  channels).
- **Two simultaneous RX clients on `/ws/live` cause one to disappear silently:**
  `InMemoryEventBus` `QueueFull` eviction has fired — implement bounded back-pressure.
- **`apps/web/features/aether-console.tsx` grows past ~2500 LOC:** split before
  comprehension cost outpaces feature velocity (PROBLEMS §2.4b already flags it).
- **A new wire-protocol field is added but only in Pydantic, not JSON Schema and TS:**
  `tests/e2e/protocol-schema.test.mjs` will pass; CI green is misleading. Add an
  ABOUT-aware regression that re-checks all three mirrors.
- **`mark_respiration_experimental` ever gets imported:** existing UI confidence-gate
  semantics will silently change because raw_window respiration fields will go missing
  before the UI ever sees them — re-evaluate the gating policy first.
