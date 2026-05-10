param(
  [Parameter(Mandatory=$true)][string]$SessionId,
  [string]$Api = "http://127.0.0.1:8000"
)

Invoke-RestMethod -Method Get -Uri "$Api/sessions/$SessionId/export" | ConvertTo-Json -Depth 10
