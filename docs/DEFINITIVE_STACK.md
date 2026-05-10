# Definitive Stack

Purpose: define the technologies uses so implementation stays coherent.

## What Is Confirmed / What Is Unknown

- [Confirmed in code] Root package and Python project metadata declare the chosen stack.
- [Confirmed in docs] ESP-IDF is the firmware rail; Arduino is not the rail.
- [Unknown / needs verification] Exact ESP-IDF version on the developer laptop is not known.

## Stack

- Firmware: ESP-IDF, C, ESP32-S3 target.
- Host API: Python 3.12+, FastAPI, Pydantic v2, asyncio.
- DSP/storage: NumPy/SciPy when installed, DuckDB/Parquet for time-series, SQLite for metadata.
- Collector: pyserial for live data and replay adapters for recorded sessions.
- UI: Next.js App Router, strict TypeScript, enterprise CSS tokens, TanStack Table/Virtual, and uPlot.
- Agent/KB: local Markdown search and deterministic tool functions before any LLM reasoning.
- Event bus: in-memory abstraction with future NATS-compatible boundaries.

## Defaults

- Default source mode: `LIVE`, unless `AETHER_REPLAY_PATH` is configured.
- Default API: `http://127.0.0.1:8000`.
- Default UI: `http://127.0.0.1:3000`.
- Default serial baud: `115200` for the current ESP-IDF USB serial console firmware.

## Non-Goals

- does not implement medical inference, identity, emotion, through-wall claims, or hidden collection.
