# Calibration runbook — breathing, HR-band readout, 3D view

Purpose: walk an operator from "two unflashed ESP32-S3 boards in a box" to
"breathing, HR-band, and 3D view all running on real data, with realistic
accuracy expectations." No placeholders, no fake data — every number you
see at the end of this runbook will come from a real measurement or an
operator-supplied geometry.

**Read `docs/VITAL_SIGNS_REALITY.md` first.** It tells you *why* breathing
will work and *why* HR-band will not match a clinical heart rate on this
hardware. This runbook tells you *how* to get the most out of both anyway.

---

## What this hardware can and cannot deliver

| Reading | Realistic accuracy on 1×TX + 1×RX ESP32-S3 PCB-antenna at 1.5–2 m | Notes |
|---|---|---|
| **Breathing rate (BPM)** | ±2 BPM in a quiet RF room, still seated subject in the LOS path. Live confidence value is the truth signal — trust HIGH only. | Achievable. Validated against metronome breathing in this runbook. |
| **HR-band BPM** | Often wrong. Sometimes matches HR ±5 BPM if the subject is exceptionally still and the breathing band is clean. | NOT a heart rate. It's "strongest periodicity in 0.8–2.5 Hz that is not a respiration harmonic". CLAUDE.md forbids calling it a heart rate. |
| **Motion / Occupancy** | Reliable once baseline is captured. | Driven by SNR-weighted bandpass-conditioned amplitude + phase. |
| **3D view pulses + blob + carpet** | Drives off real telemetry. Refuses to render until you enter geometry and frames are flowing. | Pulses appear once `raw_frame` topic delivers; blob intensity = sensed motion. |

If you want HR ±2 BPM, you need different hardware (Pulse-Fi-style mmWave
radar, or multiple synchronised RX boards). That's not a code problem.

---

## 1. One-time setup (do once per machine)

### 1.1 Toolchain
- Python 3.12 + a fresh venv at `.venv` (PowerShell or bash, both work).
- ESP-IDF v5.x active in the shell where you'll flash. Verify with `idf.py --version`.
- Node 20+ for the web UI.

### 1.2 Install repo deps
```powershell
python -m venv .venv
. .\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
npm install
```

### 1.3 Flash the firmware (operator only — agents cannot do this)
With the TX board on COM(N), RX on COM(M):
```powershell
.\scripts\flash_tx.ps1 -Port COM<TX-port>
.\scripts\flash_rx.ps1 -Port COM<RX-port>
```
You will see `cadence seq=… min=…us avg=…us max=…us target=50ms` lines from
the TX firmware once it's running, and JSON `{"type":"csi", …}` lines from
the RX. If you don't see these, the flash didn't take — re-run, watching
for `idf.py flash` errors.

### 1.4 Auto-detect the RX port and write `.env`
```powershell
.\scripts\setup_local.ps1
```
Probes each COM port for CSI traffic, writes `.env` at the repo root with
`AETHER_SERIAL_PORT=COM…`. Re-run with `-Force` after a re-flash.

---

## 2. Physical setup (do every time you move)

### 2.1 Board placement
- **Both boards at chest height of the seated subject** (≈80–110 cm above floor for a sitting person).
- **1.5–2 m apart**, antennas facing each other.
- **Subject sits on the line between the boards**, chest in the LOS path, ~50 % of the way across.
- USB cables short and straight (no active hubs — they add jitter).
- Avoid metal surfaces directly under or beside either board within 30 cm.

### 2.2 RF environment
- Pick a quiet 2.4 GHz channel. The TX firmware ships with channel 6; if your
  Wi-Fi router or neighbours hammer channel 6, change `RV_TX_CHANNEL` in
  `firmware/esp32-s3-tx/main/tx_config.h` to 1 or 11 and re-flash. Whichever
  channel shows the lowest empty-room amplitude std on the Raw Sensor page
  is the winner.
- Don't run the experiment next to a microwave oven or under fluorescent
  lights with a failing ballast — both produce 2.4 GHz interference.

### 2.3 Subject prep (if you'll measure breathing or HR-band)
- Loose-fitting cotton clothing (heavy fabric attenuates).
- Sit upright, hands on lap, avoid phone and laptop on the lap.
- For HR-band: feet flat, arms still, **no talking, no chewing** during
  the 30 s windows you care about.

---

## 3. Software bring-up

### Terminal 1 — API
```powershell
. .\.venv\Scripts\Activate.ps1
python -m uvicorn apps.api.src.main:app --reload --host 127.0.0.1 --port 8000
```
Watch for the boot line:
```
[boot] settings source_mode=LIVE serial_port=COM<X> baud=115200 ...
```

### Terminal 2 — Web UI
```powershell
npm run web:dev
```
Open http://localhost:3000 → click anywhere → Live Room.

---

## 4. Enter the room geometry (mandatory before opening `/3d`)

1. Open **Devices** (the new one, top-right of any page → "Geometry" link, or `/devices-v2`).
2. Tape-measure your room. Enter:
   - **Room (W, H, D)** in metres. H is ceiling height.
   - **TX (x, y, z)** — position of the TX board in your local frame. Use one corner of the room as (0, 0, 0).
   - **RX (x, y, z)** — same frame.
   - **Subject (x, y, z)** — optional, but needed for the blob to render. Use the chest centre when seated.
3. Click **Save geometry**. Until you do, `/3d` shows a setup-required screen.
4. Verify: the "TX↔RX entered" hint should match your tape measurement to within ±5 cm.
5. Once frames start flowing (next step), the "RSSI-implied" hint appears. If it differs from your entered distance by more than 2×, the editor surfaces a red banner. That's *expected* indoors — multipath dominates RSSI — but if it's ridiculous (e.g. you measured 1.5 m and RSSI implies 30 m) the boards aren't talking.

---

## 5. Start a session and capture an empty-room baseline (mandatory before any vitals)

1. Live Room → "Start session" (or use Experiment Console with protocol `empty_room_baseline`).
2. Within ~5 s the readiness checklist's **CSI frames flowing** light goes green.
3. **Leave the room.** Wait 10 s for the link to settle.
4. Click **Calibrate (10 s)** in the Baseline Calibration card.
5. Watch the calibrator's response:
   - **Accepted** → motion / occupancy / anomaly become trustworthy and the Subcarrier Health bars on `/raw` show a coloured "responsive set".
   - **Rejected** → the card shows `last_rejection_reason`. Common reasons:
     - "RSSI std too high" → bad link, move boards or change channel.
     - "link rate below 5 Hz floor" → the hardware Hz problem (see §8).
     - "detected motion during calibration" → you didn't actually leave.
6. Re-enter and sit still in the chair you'll use for vitals.

If the empty-room baseline keeps getting rejected, fix the link before
attempting any breathing/HR work — every downstream number depends on it.

---

## 6. Validate breathing (5 minute protocol)

This protocol is also in `docs/VITAL_SIGNS_REALITY.md` and is the only
honest way to check that breathing detection is actually working.

1. Subject in chair, baseline already captured (§5).
2. **Hold breath for 15 s.** The Respiration card's confidence should drop and the BPM display should clear.
3. **Resume normal breathing for 30 s.** Respiration card should populate, confidence climbs to MEDIUM or HIGH.
4. **Pace at 6 BPM with a metronome** (10 s in / 10 s out) for 60 s. Display should land at ~6 BPM with HIGH confidence.
5. **Pace at 20 BPM** (1.5 s in / 1.5 s out) for 60 s. Display should land at ~20 BPM.
6. **Walk across the link.** "Stillness gate active — vital readings suppressed" appears within 2–3 s; both BPM cards clear.

If steps 4 or 5 land more than ±3 BPM off the metronome, your physical
setup is wrong (subject too far from LOS, chest not in line, or a noisy
RF environment) — fix that, not the code.

The respiration BPM you see is the **`respiration_tracked_bpm`** field —
EWMA-smoothed across windows. The instantaneous `respiration_bpm` is also
in the API but is noisier. The UI prefers the tracked value.

---

## 7. Validate HR-band readout — and what to expect

**Read this first.** The HR-band BPM is the strongest periodicity in
0.8–2.5 Hz that is *not* a respiration harmonic. On this hardware it
fails to match a true heart rate **most of the time**.

Protocol:
1. Steps 1–3 of §6 first. Breathing must be locked in before HR-band has a
   prayer of being meaningful (the harmonic-rejection logic in
   `services/dsp/src/biorhythm.py` needs a clean breathing fundamental to
   subtract).
2. Subject sits absolutely still, hands on knees, eyes closed, breathing
   normally.
3. Watch the "Periodic motion in HR band" card for ≥ 60 s.
4. Optional ground truth: wear a Polar H10 (or any chest strap) connected
   to a phone. Compare displayed BPM against H10 BPM.

What you'll see:
- **Card stays empty** → the most common case. Stillness gate active, or
  confidence below 0.45, or the HR-band peak looks like a respiration
  harmonic. This is **honest behaviour**.
- **Card shows a number that matches H10 ±5 BPM** → genuinely good
  geometry + lucky RF. Take the win, don't expect repeatability.
- **Card shows a number that's roughly 2× respiration BPM** → the harmonic-
  rejection threshold (within 7 % of 2×respiration) didn't fire. The
  reading is a respiration harmonic; ignore.
- **Card shows a stable but H10-disagreeing number** → it's some other
  periodic motion (fan, fluorescent ballast hum, your phone's haptics).
  The hardware genuinely cannot disambiguate.

There is **nothing software can do today** to push HR-band toward
clinical accuracy on this hardware. Path forward is in
`docs/VITAL_SIGNS_REALITY.md` §"How to actually get to clinical-grade BPM"
— all hardware additions, none of which you said you want.

---

## 8. Validate the 3D view

1. With geometry saved (§4) and a session running (§5), open `/3d`.
2. The HUD should show source mode `LIVE` (or `REPLAY`) and a non-zero
   `obs Hz` once frames start arriving.
3. Within ~1 s, **wave pulses** start expanding from TX. Brightness varies
   with each frame's RSSI. If pulses don't appear: the page hasn't
   subscribed to the `raw_frame` topic — check the bottom-left layer
   toggle "subscribe to raw_frame" is on.
4. **Subcarrier carpet** appears as a wavy ribbon between TX and RX,
   updated each derived window.
5. **Subject blob** at the operator-supplied subject position, growing
   and brightening as you wave a hand near the LOS. With nobody in the
   room, blob radius collapses to its baseline.
6. Camera presets: keys 1 (Birds-eye), 2 (Side), 3 (Front), 4 (Free orbit).
7. **Pop-out**: top-right "⇗ Pop out" opens `/3d?embed=1` in a new window
   with no chrome — useful for a second monitor.

If the blob never moves regardless of what you do near the link, the
pipeline isn't producing motion. Check the Live Room motion_score; it
should track your hand wave. If it doesn't, the baseline calibration
failed silently — re-do §5.

---

## 9. Diagnostic ladder (use when something doesn't work)

Walk these in order. Each rules out one layer.

1. **Open `/raw`.** Look at "Link Diagnostics" first.
   - `frames seen = 0` → host isn't reading the serial port. Check `.env` `AETHER_SERIAL_PORT`, re-run `setup_local.ps1`.
   - `frames seen > 0` but `observed Hz < 5` → real link problem. Continue.
2. **Look at firmware drops.** If `firmware_dropped > 0` or `queue_depth > 4`, the host is too slow to drain the RX. Try `AETHER_SERIAL_MODE=async` (planned env var; until landed, a Linux live-USB test is the fastest validator — see `PLAN_3D_RAW_CALIBRATION.md` §6.1).
3. **Look at TX cadence in the firmware log.** Connect a serial monitor to the TX board (PuTTY, Arduino IDE Serial Monitor). Lines like `cadence seq=200 min=49000us avg=50000us max=51000us` mean firmware is fine; if min/max are far from 50000us, the firmware itself is jittering.
4. **Check the subcarrier health bars on `/raw`.** If they're all flat and grey, the calibrator didn't fire or was rejected — re-run §5.
5. **Run `scripts\validate_accuracy.py data\recordings\<session-id>.jsonl`** on a fresh recording to assert sanity bounds. Failing means the DSP is producing degenerate output.

---

## 10. What to do *not* do

- Do not call the HR-band number "heart rate" outside of this system. Per
  CLAUDE.md.
- Do not calibrate while moving — the acceptance gates will reject it but
  if they let it through, every downstream number is biased.
- Do not save partial geometry and pretend `/3d` is showing a real room —
  the page refuses to render without all three (room + TX + RX).
- Do not interpret RSSI-implied distance as a real measurement. It's a
  ±50 % indoor sanity check.
