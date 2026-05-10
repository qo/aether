#!/usr/bin/env sh
set -eu

: "${AETHER_SERIAL_PORT:?Set AETHER_SERIAL_PORT to the RX serial device.}"
: "${AETHER_BAUD:=115200}"

echo "Aether hardware check"
echo "Serial port: ${AETHER_SERIAL_PORT}"
echo "Baud: ${AETHER_BAUD}"
echo "Use scripts/hardware_check.ps1 on Windows for active serial probing."
