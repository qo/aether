# Firmware

Purpose: describe the two ESP32-S3 firmware applications.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] `firmware/esp32-s3-tx` and `firmware/esp32-s3-rx` are ESP-IDF projects.
- [Confirmed in docs] CSI callbacks run in the Wi-Fi task and should not do lengthy work.
- [Unknown / needs verification] Live firmware must be built and flashed with a local ESP-IDF install.

## TX Firmware

The TX board creates the controlled Wi-Fi traffic source. uses UDP packets at a configurable cadence against the RX board on a fixed SSID/channel.

## RX Firmware

The RX board joins the controlled link, enables CSI, queues callback data, and writes line-delimited serial frames. Heartbeat/status lines let the host distinguish a dead stream from quiet RF.

## Flash Commands

```powershell
.\scripts\flash_tx.ps1 -Port COM3
.\scripts\flash_rx.ps1 -Port COM4
```
