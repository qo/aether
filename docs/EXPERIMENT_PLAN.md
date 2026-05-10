# Experiment Plan

Purpose: define the first controlled experiments for two ESP32-S3 boards.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Protocol definitions exist for experiment flows.
- [Unknown / needs verification] Which geometry produces the cleanest separation must be measured.

## Protocols

- `empty_room_baseline`
- `human_presence_static`
- `enter_exit`
- `cross_line_of_sight`
- `hand_wave_near_link`
- `distance_sweep`
- `board_orientation_sweep`
- `packet_rate_sweep`
- `seated_breathing_exploration`
- `environmental_noise_test`

## Day-One Acceptance

- Stable CSI stream.
- Visible subcarrier traces.
- Occupancy/anomaly score separates empty and occupied better than baseline noise.
- Motion score responds to hand wave and LoS crossing.
- Respiration only reported as experimental if confidence supports it.
