param(
  [string]$RxPort = $env:AETHER_SERIAL_PORT,
  [int]$Baud = [int]($env:AETHER_BAUD -as [int])
)

if (-not $Baud) { $Baud = 115200 }

Write-Host "Aether hardware check"
Write-Host "Available serial ports:"
Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Description | Format-Table

if (-not $RxPort) {
  Write-Host "YELLOW: AETHER_SERIAL_PORT or -RxPort is not set."
  exit 2
}

try {
  $port = New-Object System.IO.Ports.SerialPort $RxPort, $Baud, None, 8, one
  $port.ReadTimeout = 3000
  $port.Open()
  $deadline = (Get-Date).AddSeconds(5)
  $sawHeartbeat = $false
  $sawCsi = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $line = $port.ReadLine()
      if ($line -match '"type"\s*:\s*"heartbeat"') { $sawHeartbeat = $true }
      if ($line -match '"type"\s*:\s*"csi"') { $sawCsi = $true }
      if ($sawHeartbeat -and $sawCsi) { break }
    } catch {}
  }
  $port.Close()
  if ($sawHeartbeat -and $sawCsi) {
    Write-Host "GREEN: heartbeat and CSI frames observed."
    exit 0
  }
  if ($sawHeartbeat) {
    Write-Host "YELLOW: heartbeat observed but no CSI frame in 5 seconds."
    exit 2
  }
  Write-Host "RED: no heartbeat or CSI frame observed."
  exit 1
} catch {
  Write-Host "RED: failed to read serial port $RxPort"
  Write-Host $_
  exit 1
}
