#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#include "csi_capture.h"

static const char *TAG = "aether_csi";
static QueueHandle_t s_csi_queue;
static uint32_t s_seq;

static void csi_rx_cb(void *ctx, wifi_csi_info_t *data)
{
    (void)ctx;
    if (data == NULL || data->buf == NULL || s_csi_queue == NULL) {
        return;
    }

    rv_csi_packet_t packet = {0};
    packet.seq = s_seq++;
    packet.ts_device_us = esp_timer_get_time();
    packet.rssi = data->rx_ctrl.rssi;
    packet.noise_floor = data->rx_ctrl.noise_floor;
    packet.channel = data->rx_ctrl.channel;
    packet.sig_mode = data->rx_ctrl.sig_mode;
    packet.cwb = data->rx_ctrl.cwb;
    packet.secondary_channel = data->rx_ctrl.secondary_channel;
    packet.stbc = data->rx_ctrl.stbc;
    packet.first_word_invalid = data->first_word_invalid;
    packet.len = data->len > RV_MAX_CSI_BYTES ? RV_MAX_CSI_BYTES : data->len;
    memcpy(packet.buf, data->buf, packet.len);

    (void)xQueueSend(s_csi_queue, &packet, 0);
}

void rv_csi_init(void)
{
    s_csi_queue = xQueueCreate(32, sizeof(rv_csi_packet_t));
    wifi_csi_config_t csi_config = {
        .lltf_en = true,
        .htltf_en = true,
        .stbc_htltf2_en = true,
        .ltf_merge_en = true,
        .channel_filter_en = false,
        .manu_scale = false,
        .shift = false,
    };

    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_config));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));
    ESP_LOGI(TAG, "CSI enabled");
}

bool rv_csi_receive(rv_csi_packet_t *packet, uint32_t timeout_ms)
{
    return xQueueReceive(s_csi_queue, packet, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}
