#pragma once

#include <stdint.h>

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t sequence;
    uint64_t device_time_us;
    uint8_t payload[96];
} rv_tx_packet_t;

#define RV_TX_MAGIC 0x52565458u
