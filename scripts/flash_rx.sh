#!/usr/bin/env sh
set -eu

: "${PORT:?Set PORT to the RX serial device.}"

cd firmware/esp32-s3-rx
idf.py set-target esp32s3
idf.py build
idf.py -p "$PORT" -b "${BAUD:-921600}" flash
