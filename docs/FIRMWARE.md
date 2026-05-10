# Firmware

Purpose: describe the two ESP32-S3 firmware applications.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] `firmware/esp32-s3-tx` and `firmware/esp32-s3-rx` are ESP-IDF projects.
- [Confirmed in docs] CSI callbacks run in the Wi-Fi task and should not do lengthy work.
- [Unknown / needs verification] Live firmware must be built and flashed with a local ESP-IDF install.

## TX Firmware

The TX board creates the controlled Wi-Fi traffic source. Uses UDP packets at a configurable cadence (default 50 ms / 20 Hz) against the RX board on a fixed SSID/channel.

## RX Firmware

The RX board joins the controlled link, enables CSI, queues callback data, and writes line-delimited serial frames. Heartbeat/status lines let the host distinguish a dead stream from quiet RF.

## Flash Commands

```powershell
.\scripts\flash_rx.ps1 -Port COM10
.\scripts\flash_tx.ps1 -Port COM9
```

`-Baud 921600` is the default and is used for the *flash transfer*, not the runtime UART baud (which is set in `sdkconfig.defaults`).

## Throughput math (the reason for the optimisations below)

A typical CSI frame on this firmware emits ~128–384 bytes of int8 I/Q. JSON-encoded as `[-128,-127,…]`, an int8 byte costs ~4 ASCII chars (digits + comma). The fixed envelope adds another ~240 bytes. Worst case per frame: ~1700–2200 bytes.

At the previous 115200 baud the UART carried ~11.5 KB/s, which caps the link at:

```
11500 bytes/s ÷ 1750 bytes/frame ≈ 6.6 frames/s
```

That's the ~5–7 Hz steady state we observed in `/diagnostics/link`. Wi-Fi delivered CSI at ~20 Hz, so the firmware-side queue overflowed and roughly two thirds of frames were dropped *before* they reached the UART. The host could read every byte the port handed it; nothing host-side could lift the rate.

## RX firmware optimisations (2026-05-10)

Four changes, all in `firmware/esp32-s3-rx/`:

1. **UART baud 115200 → 921600.** `sdkconfig.defaults` now sets `CONFIG_ESP_CONSOLE_UART_BAUDRATE=921600` and `CONFIG_ESPTOOLPY_MONITOR_BAUD_OTHER_VAL=921600`. New ceiling at JSON sizes is ~50 frames/s, comfortably above the 20 Hz Wi-Fi cadence. The host (`AETHER_BAUD` in `.env`) is bumped to match — a baud mismatch surfaces as garbled bytes, not a clean error.
2. **Single-buffer JSON write.** `serial_protocol.c` previously issued ~390 `printf()` calls per frame (one per metadata field plus one per byte of the I/Q array). Each `printf` paid a newlib mutex acquisition and a VFS round trip. The rewrite renders the entire envelope into one 2.5 KB static buffer and emits it via a single `fwrite() + fflush()`. Per-frame CPU on the serial task drops by ~2 orders of magnitude.
3. **Tasks pinned to opposite cores.** `udp_sink_task` stays on PRO_CPU (core 0) alongside Wi-Fi/LWIP. `serial_task` is pinned to APP_CPU (core 1) so the per-frame snprintf + UART write never preempts the CSI rx callback.
4. **CSI queue depth 32 → 64.** Pure jitter cushion. With UART now faster than Wi-Fi the queue is empty in steady state; a deeper buffer absorbs ~3 s of host-side stalls (GC, scheduler hiccup) at 20 Hz before any frame is dropped.

### Picking up the new defaults

ESP-IDF does **not** apply `sdkconfig.defaults` retroactively to an existing `sdkconfig`. After pulling these changes, force a regeneration:

```powershell
cd firmware/esp32-s3-rx
Remove-Item sdkconfig         # or: idf.py reconfigure
idf.py build
idf.py -p COM10 flash
```

Confirm the new baud after boot:

```powershell
# In a separate PowerShell (don't keep this running; it grabs the port)
python scripts/probe_serial.py --port COM10 --baud 921600
```

You should see clean JSON; if you see garbled bytes, your USB-UART bridge probably can't sustain 921600. CP2102N / CH9102 / CH340E (the chips on common ESP32-S3 dev boards) all handle it. If yours can't, drop both `CONFIG_ESP_CONSOLE_UART_BAUDRATE` and `AETHER_BAUD` to **460800** — it still gives 4× the previous capacity.

### Rollback

If the new firmware misbehaves on your hardware, revert by:

1. Set `CONFIG_ESP_CONSOLE_UART_BAUDRATE=115200` in `firmware/esp32-s3-rx/sdkconfig.defaults`.
2. `Remove-Item sdkconfig; idf.py build; idf.py -p COM10 flash`
3. Set `AETHER_BAUD=115200` in the repo-root `.env` and restart the API.

You're back to the pre-2026-05-10 state. The `printf`-per-byte path was removed but the JSON it produces is byte-identical to the old one — the host parser does not need to change.

## Where the next wins live

If 20 Hz JSON over 921600 still isn't enough (e.g. multi-link CSI, finer subcarrier counts), the next steps in order of impact:

- **Binary frame format** (drop ASCII expansion of I/Q). 4× smaller payload. Requires host parser changes.
- **Drop unused fields** (`cwb`, `secondary_channel`, `stbc`) from the JSON envelope.
- **On-device subcarrier averaging or edge-trim** — we already trim edges in DSP host-side; doing it on-device cuts payload further.
- **Higher UART baud** — ESP32-S3 supports up to 5 Mbaud, but real-world USB-UART bridges typically max out around 2 Mbaud and start losing bytes above that. Test before committing.

None of these are required for the current 20 Hz target.
