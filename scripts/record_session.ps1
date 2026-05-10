param(
  [string]$Protocol = "empty_room_baseline",
  [string]$Api = "http://127.0.0.1:8000"
)

$session = Invoke-RestMethod -Method Post -Uri "$Api/sessions" -ContentType "application/json" -Body (@{ protocol = $Protocol; notes = "record_session.ps1" } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$Api/sessions/$($session.session_id)/start" | Out-Null
Write-Host "Recording session $($session.session_id)"
Write-Host "Stop with: Invoke-RestMethod -Method Post -Uri $Api/sessions/$($session.session_id)/stop"
