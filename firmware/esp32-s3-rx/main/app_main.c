#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <arpa/inet.h>
#include <netinet/in.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "csi_capture.h"
#include "serial_protocol.h"

#define RV_RX_SSID "AETHER_V0"
#define RV_RX_PASS "aether-v0"
#define RV_RX_UDP_PORT 33330

static const char *TAG = "AETHER_rx";
static EventGroupHandle_t s_wifi_event_group;
static const int WIFI_CONNECTED_BIT = BIT0;

static void event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_data;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "disconnected; reconnecting");
        esp_wifi_connect();
        xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init_sta(void)
{
    s_wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL, NULL));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = RV_RX_SSID,
            .password = RV_RX_PASS,
            .threshold.authmode = WIFI_AUTH_WPA_WPA2_PSK,
        },
    };

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW20));
}

static void udp_sink_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "udp socket failed");
        vTaskDelete(NULL);
        return;
    }

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(RV_RX_UDP_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    bind(sock, (struct sockaddr *)&addr, sizeof(addr));

    struct timeval timeout = {
        .tv_sec = 0,
        .tv_usec = 250000,
    };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    struct sockaddr_in tx_addr = {
        .sin_family = AF_INET,
        .sin_port = htons(RV_RX_UDP_PORT),
        .sin_addr.s_addr = inet_addr("192.168.4.1"),
    };

    const uint8_t hello[] = "rv-rx-ready";
    uint8_t buffer[256];
    int64_t last_hello = 0;
    while (true) {
        int64_t now = esp_timer_get_time();
        if (now - last_hello > 500000) {
            sendto(sock, hello, sizeof(hello), 0, (struct sockaddr *)&tx_addr, sizeof(tx_addr));
            last_hello = now;
        }
        recv(sock, buffer, sizeof(buffer), 0);
    }
}

static void serial_task(void *arg)
{
    (void)arg;
    rv_csi_packet_t packet;
    uint32_t packets_seen = 0;
    int64_t last_heartbeat = 0;

    while (true) {
        if (rv_csi_receive(&packet, 500)) {
            packets_seen++;
            rv_serial_write_csi(&packet);
        }
        int64_t now = esp_timer_get_time();
        if (now - last_heartbeat > 1000000) {
            rv_serial_write_heartbeat(packets_seen);
            last_heartbeat = now;
        }
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

    wifi_init_sta();
    xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
    rv_csi_init();
    xTaskCreate(udp_sink_task, "rv_udp_sink", 4096, NULL, 4, NULL);
    xTaskCreate(serial_task, "rv_serial", 8192, NULL, 5, NULL);
    ESP_LOGI(TAG, "RX ready");
}
