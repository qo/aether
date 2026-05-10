# Manual Validation Runbook

Purpose: provide a short human validation flow for the two-board current slice.

## What Is Confirmed / What Is Unknown

- [Confirmed in docs] This runbook matches the current scope path.
- [Unknown / needs verification] Hardware-specific COM ports must be filled in locally.

## Steps

1. Flash TX and RX with ESP-IDF.
2. Put boards 1.5-2 m apart at torso height.
3. Start API in `LIVE` mode with the RX serial port configured.
4. Start UI and verify the source badge says `LIVE`.
5. Record a two-minute empty baseline.
6. Add labels for enter, sit still, hand wave, cross LoS, and exit.
7. Stop the session.
8. Replay the session and confirm the badge says `REPLAY`.
9. Generate a report and record what can and cannot be concluded.
