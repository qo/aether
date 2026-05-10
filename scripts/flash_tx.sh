#!/usr/bin/env sh
set -eu

: "${PORT:?Set PORT to the TX serial device.}"

cd firmware/esp32-s3-tx
idf.py set-target esp32s3
idf.py build
idf.py -p "$PORT" -b "${BAUD:-921600}" flash
