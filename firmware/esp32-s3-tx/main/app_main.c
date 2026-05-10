#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "tx_config.h"
#include "tx_protocol.h"

static const char *TAG = "aether_tx";

static void wifi_init_softap(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    wifi_config_t wifi_config = {
        .ap = {
            .ssid = RV_TX_SSID,
            .ssid_len = strlen(RV_TX_SSID),
            .channel = RV_TX_CHANNEL,
            .password = RV_TX_PASS,
            .max_connection = 2,
            .authmode = WIFI_AUTH_WPA_WPA2_PSK,
        },
    };

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20));

    ESP_LOGI(TAG, "TX SoftAP started ssid=%s channel=%d", RV_TX_SSID, RV_TX_CHANNEL);
}

static void udp_sender_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket create failed");
        vTaskDelete(NULL);
        return;
    }

    int broadcast = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast));
    fcntl(sock, F_SETFL, O_NONBLOCK);

    struct sockaddr_in local = {
        .sin_family = AF_INET,
        .sin_port = htons(RV_TX_UDP_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&local, sizeof(local)) < 0) {
        ESP_LOGW(TAG, "udp bind failed; continuing transmit-only");
    }

    struct sockaddr_in broadcast_dest = {
        .sin_family = AF_INET,
        .sin_port = htons(RV_TX_UDP_PORT),
        .sin_addr.s_addr = inet_addr("192.168.4.255"),
    };
    struct sockaddr_in peer_dest = {0};
    bool have_peer = false;

    rv_tx_packet_t packet = {0};
    packet.magic = RV_TX_MAGIC;
    for (size_t i = 0; i < sizeof(packet.payload); i++) {
        packet.payload[i] = (uint8_t)(i & 0xff);
    }

    // Phase A cadence instrumentation: every CADENCE_LOG_EVERY packets we
    // print measured min/avg/max inter-packet interval in microseconds.
    // This is the ground truth for "did the TX really emit at 50 ms?"
    const uint32_t CADENCE_LOG_EVERY = 200;
    int64_t last_tx_us = 0;
    int64_t cadence_min_us = INT64_MAX;
    int64_t cadence_max_us = 0;
    int64_t cadence_sum_us = 0;
    uint32_t cadence_samples = 0;

    while (true) {
        uint8_t hello[32];
        struct sockaddr_in from = {0};
        socklen_t from_len = sizeof(from);
        int received = recvfrom(sock, hello, sizeof(hello), 0, (struct sockaddr *)&from, &from_len);
        if (received > 0) {
            if (!have_peer || peer_dest.sin_addr.s_addr != from.sin_addr.s_addr || peer_dest.sin_port != from.sin_port) {
                peer_dest = from;
                have_peer = true;
                ESP_LOGI(TAG, "RX peer registered ip=%s port=%u", inet_ntoa(from.sin_addr), ntohs(from.sin_port));
            }
        } else if (received < 0 && errno != EWOULDBLOCK && errno != EAGAIN) {
            ESP_LOGD(TAG, "recvfrom failed while checking RX hello");
        }

        packet.sequence++;
        packet.device_time_us = (uint64_t)esp_timer_get_time();

        // Measure cadence between two successive transmits, not between
        // vTaskDelay calls — the recvfrom above can drift the loop.
        if (last_tx_us > 0) {
            int64_t dt = (int64_t)packet.device_time_us - last_tx_us;
            if (dt > 0) {
                if (dt < cadence_min_us) cadence_min_us = dt;
                if (dt > cadence_max_us) cadence_max_us = dt;
                cadence_sum_us += dt;
                cadence_samples++;
            }
        }
        last_tx_us = (int64_t)packet.device_time_us;

        const struct sockaddr_in *dest = have_peer ? &peer_dest : &broadcast_dest;
        int sent = sendto(sock, &packet, sizeof(packet), 0, (const struct sockaddr *)dest, sizeof(*dest));
        if (sent < 0) {
            ESP_LOGW(TAG, "sendto failed");
        } else if ((packet.sequence % CADENCE_LOG_EVERY) == 0 && cadence_samples > 0) {
            int64_t avg = cadence_sum_us / (int64_t)cadence_samples;
            ESP_LOGI(TAG, "cadence seq=%lu samples=%lu min=%lldus avg=%lldus max=%lldus target=%dms mode=%s",
                     packet.sequence,
                     cadence_samples,
                     cadence_min_us,
                     avg,
                     cadence_max_us,
                     RV_TX_PACKET_INTERVAL_MS,
                     have_peer ? "unicast" : "broadcast");
            cadence_min_us = INT64_MAX;
            cadence_max_us = 0;
            cadence_sum_us = 0;
            cadence_samples = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(RV_TX_PACKET_INTERVAL_MS));
    }
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    wifi_init_softap();
    xTaskCreate(udp_sender_task, "rv_udp_sender", 4096, NULL, 5, NULL);
}
