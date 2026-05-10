#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "esp_timer.h"

#include "serial_protocol.h"

/*
 * Single-buffer JSON build, single stdout write.
 *
 * The previous implementation issued ~390 separate printf() calls per CSI
 * frame (one per metadata field plus one per int8 in the I/Q array). Each
 * printf goes through newlib + the IDF VFS layer with a global stdout
 * lock, so a 384-byte frame paid ~390 mutex acquisitions and 390 round
 * trips through vfs_uart. Combined with the 115200-baud UART line speed
 * that was the dominant CPU cost on the serial task and contributed to
 * the firmware-side CSI queue overflow under load.
 *
 * This rewrite renders the whole envelope into a per-task static buffer
 * with bounded snprintf and emits it in one fwrite()+fflush() pair. We
 * keep using stdout (rather than uart_write_bytes against UART_NUM_0)
 * because installing our own UART driver would race with ESP_LOG output
 * from other tasks. fwrite is still ~1 mutex acquisition per frame.
 *
 * Worst-case payload size:
 *
 *     fixed JSON envelope:                ~ 240 bytes
 *     I/Q array, 384 bytes × max 5 chars: ~1920 bytes (incl. commas)
 *     trailing brackets + newline:        ~  16 bytes
 *     ----------------------------------------------
 *     total worst-case:                   ~2200 bytes
 *
 * Buffer is sized 2560 with a runtime guard so an oversized payload
 * truncates cleanly instead of corrupting RAM.
 *
 * The buffer is `static` (file scope, single-writer — only the serial
 * task calls these functions) so we don't blow the 8 KB task stack.
 */
#define RV_SERIAL_BUFFER_BYTES 2560

static char s_serial_buffer[RV_SERIAL_BUFFER_BYTES];

/* Append helper that returns bytes written (0 on overflow). Callers must
 * track `pos` and bail out as soon as a write returns 0. */
static int rv_append(char *buf, int cap, int pos, const char *fmt, ...)
{
    if (pos >= cap - 1) {
        return 0;
    }
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + pos, (size_t)(cap - pos), fmt, ap);
    va_end(ap);
    if (n < 0) return 0;
    if (n >= cap - pos) return 0;   /* would have overflowed */
    return n;
}

static void rv_emit(const char *buf, size_t len)
{
    if (len == 0) return;
    /* fwrite + fflush gives us a single trip through newlib instead of
     * one per field. Line is already \n-terminated, so on a line-buffered
     * stdout the fflush is technically redundant — but USB-CDC consoles
     * sometimes report as block-buffered, so we flush to be safe. */
    fwrite(buf, 1, len, stdout);
    fflush(stdout);
}

void rv_serial_write_csi(const rv_csi_packet_t *packet)
{
    char *buf = s_serial_buffer;
    const int cap = RV_SERIAL_BUFFER_BYTES;
    int pos = 0;
    int n;

    n = rv_append(buf, cap, pos,
        "{\"type\":\"csi\",\"payload\":{"
        "\"schema_version\":\"csi_frame.v1\","
        "\"device_id\":\"esp32-s3-rx\","
        "\"device_role\":\"rx\","
        "\"seq\":%lu,"
        "\"ts_device_us\":%lld,"
        "\"channel\":%u,"
        "\"rssi_dbm\":%d,"
        "\"noise_floor_dbm\":%d,"
        "\"sig_mode\":%u,"
        "\"cwb\":%u,"
        "\"secondary_channel\":%u,"
        "\"stbc\":%u,"
        "\"first_word_invalid\":%s,"
        "\"payload_len\":%u,"
        "\"raw_iq_int8\":[",
        (unsigned long)packet->seq,
        (long long)packet->ts_device_us,
        (unsigned)packet->channel,
        (int)packet->rssi,
        (int)packet->noise_floor,
        (unsigned)packet->sig_mode,
        (unsigned)packet->cwb,
        (unsigned)packet->secondary_channel,
        (unsigned)packet->stbc,
        packet->first_word_invalid ? "true" : "false",
        (unsigned)packet->len);
    if (n == 0) goto emit;
    pos += n;

    /* I/Q array. Tight loop: snprintf is the hot path. Reserve 8 bytes for
     * the closing "]}}\n" so we always emit valid JSON even on truncation. */
    for (uint16_t i = 0; i < packet->len; i++) {
        if (pos + 8 >= cap) break;
        if (i == 0) {
            n = snprintf(buf + pos, (size_t)(cap - pos),
                         "%d", (int)packet->buf[i]);
        } else {
            n = snprintf(buf + pos, (size_t)(cap - pos),
                         ",%d", (int)packet->buf[i]);
        }
        if (n <= 0 || n >= cap - pos) break;
        pos += n;
    }

    n = rv_append(buf, cap, pos, "]}}\n");
    pos += n;

emit:
    rv_emit(buf, (size_t)pos);
}

void rv_serial_write_heartbeat(uint32_t packets_seen,
                               uint32_t dropped,
                               uint32_t queue_depth)
{
    int n = snprintf(s_serial_buffer, RV_SERIAL_BUFFER_BYTES,
        "{\"type\":\"heartbeat\",\"firmware\":\"aether-rx-v0\","
        "\"packets_seen\":%lu,\"dropped\":%lu,\"queue_depth\":%lu,"
        "\"uptime_us\":%lld}\n",
        (unsigned long)packets_seen,
        (unsigned long)dropped,
        (unsigned long)queue_depth,
        (long long)esp_timer_get_time());
    if (n > 0 && n < RV_SERIAL_BUFFER_BYTES) {
        rv_emit(s_serial_buffer, (size_t)n);
    }
}
