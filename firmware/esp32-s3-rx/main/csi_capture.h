#pragma once

#include <stdbool.h>
#include <stdint.h>

#define RV_MAX_CSI_BYTES 384

typedef struct {
    uint32_t seq;
    int64_t ts_device_us;
    int8_t rssi;
    int8_t noise_floor;
    uint8_t channel;
    uint8_t sig_mode;
    uint8_t cwb;
    uint8_t secondary_channel;
    uint8_t stbc;
    bool first_word_invalid;
    uint16_t len;
    int8_t buf[RV_MAX_CSI_BYTES];
} rv_csi_packet_t;

void rv_csi_init(void);
bool rv_csi_receive(rv_csi_packet_t *packet, uint32_t timeout_ms);
