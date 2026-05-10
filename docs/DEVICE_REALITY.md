# Device Reality

Purpose: separate confirmed device capability from assumptions and future hardware ideas.

## What Is Confirmed / What Is Unknown

- [Confirmed in docs] ESP-IDF documents ESP32-S3 Wi-Fi CSI setup with `esp_wifi_set_csi_rx_cb`, `esp_wifi_set_csi_config`, and `esp_wifi_set_csi`.
- [Confirmed in docs] Espressif's CSI example uses two Espressif boards, one sender and one receiver.
- [Unknown / needs verification] The exact board models, antenna types, and serial ports are not yet recorded.
- [Unknown / needs verification] The live packet rate and CSI frame validity must be measured on hardware.

## Topology

- Board A: `esp32-s3-tx`, controlled sender / illuminator.
- Board B: `esp32-s3-rx`, CSI receiver.
- Host: collector, storage, DSP, API, UI, experiments, KB, and agent tools.

## First Setup

- Place boards 1.5-2 m apart.
- Use torso height when testing human presence and motion.
- Start with an empty-room baseline.
- Record board orientation, channel, packet cadence, distance, and notes for every session.

## Future Adapters

ESP32-C5/C6, Nexmon CSI, AX210/FeitCSI/PicoScenes, mmWave radar, SDR, and validation sensors should adapt into `csi_frame.v1` or a future sibling raw-observation schema.
