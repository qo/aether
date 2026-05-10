#include <stdio.h>

#include "esp_timer.h"

#include "serial_protocol.h"

void rv_serial_write_csi(const rv_csi_packet_t *packet)
{
    printf("{\"type\":\"csi\",\"payload\":{");
    printf("\"schema_version\":\"csi_frame.v1\",");
    printf("\"device_id\":\"esp32-s3-rx\",");
    printf("\"device_role\":\"rx\",");
    printf("\"seq\":%lu,", packet->seq);
    printf("\"ts_device_us\":%lld,", packet->ts_device_us);
    printf("\"channel\":%u,", packet->channel);
    printf("\"rssi_dbm\":%d,", packet->rssi);
    printf("\"noise_floor_dbm\":%d,", packet->noise_floor);
    printf("\"sig_mode\":%u,", packet->sig_mode);
    printf("\"cwb\":%u,", packet->cwb);
    printf("\"secondary_channel\":%u,", packet->secondary_channel);
    printf("\"stbc\":%u,", packet->stbc);
    printf("\"first_word_invalid\":%s,", packet->first_word_invalid ? "true" : "false");
    printf("\"payload_len\":%u,", packet->len);
    printf("\"raw_iq_int8\":[");
    for (uint16_t i = 0; i < packet->len; i++) {
        printf("%s%d", i == 0 ? "" : ",", packet->buf[i]);
    }
    printf("]}}\n");
}

void rv_serial_write_heartbeat(uint32_t packets_seen,
                               uint32_t dropped,
                               uint32_t queue_depth)
{
    // queue_depth is messages currently buffered between the Wi-Fi callback
    // and the serial task — a non-zero steady-state value means the host is
    // not draining fast enough. dropped is monotonic since boot.
    printf("{\"type\":\"heartbeat\",\"firmware\":\"aether-rx-v0\","
           "\"packets_seen\":%lu,\"dropped\":%lu,\"queue_depth\":%lu,"
           "\"uptime_us\":%lld}\n",
           packets_seen,
           dropped,
           queue_depth,
           esp_timer_get_time());
}
