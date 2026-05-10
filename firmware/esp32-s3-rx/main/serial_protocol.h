#pragma once

#include "csi_capture.h"

void rv_serial_write_csi(const rv_csi_packet_t *packet);
void rv_serial_write_heartbeat(uint32_t packets_seen);
