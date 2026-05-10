param(
  [Parameter(Mandatory=$true)][string]$SessionId
)

Write-Host "Replay is implemented as a collector adapter in services/collector/src/replay.py."
Write-Host "Recording path: data/recordings/$SessionId.jsonl"
Write-Host "Set AETHER_REPLAY_PATH to this path before starting the API."
