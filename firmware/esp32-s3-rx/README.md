# ESP32-S3 RX Firmware

Purpose: join the TX board Wi-Fi link, enable CSI reception, and emit line-delimited serial frames.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] CSI callback copies bounded frame data into a FreeRTOS queue and serializes from a separate task.
- [Unknown / needs verification] Exact CSI metadata fields can vary by ESP-IDF version and may require local compile fixes.

## Build

```powershell
idf.py set-target esp32s3
idf.py build
idf.py -p COM4 flash monitor
```
