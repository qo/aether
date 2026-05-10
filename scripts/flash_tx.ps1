param(
  [Parameter(Mandatory=$true)][string]$Port,
  [int]$Baud = 921600
)

Push-Location firmware/esp32-s3-tx
try {
  idf.py set-target esp32s3
  idf.py build
  idf.py -p $Port -b $Baud flash
} finally {
  Pop-Location
}
