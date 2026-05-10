param(
  [Parameter(Mandatory=$true)][string]$Port,
  [int]$Baud = 921600,
  # -Fresh forces sdkconfig + build artifacts to be regenerated from
  # sdkconfig.defaults. Required after any change to the defaults file
  # (e.g. the 2026-05-10 UART baud bump from 115200 -> 921600). ESP-IDF
  # does not apply defaults retroactively to an existing sdkconfig.
  [switch]$Fresh
)

Push-Location firmware/esp32-s3-rx
try {
  if ($Fresh) {
    if (Test-Path sdkconfig) { Remove-Item sdkconfig }
    idf.py fullclean
  }
  idf.py set-target esp32s3
  idf.py build
  idf.py -p $Port -b $Baud flash
} finally {
  Pop-Location
}
