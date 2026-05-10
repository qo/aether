# ESP32-S3 TX Firmware

Purpose: create the controlled Wi-Fi traffic source used by the RX board to collect CSI.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] This project configures an ESP32-S3 SoftAP and broadcasts UDP packets at a fixed cadence.
- [Unknown / needs verification] TX power and exact packet cadence should be measured on hardware.

## Build

```powershell
idf.py set-target esp32s3
idf.py build
idf.py -p COM3 flash monitor
```
