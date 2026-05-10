from aether_protocol import SourceMode
from services.collector.src.parser import parse_serial_line


def test_parse_csi_line():
    message = parse_serial_line(
        '{"type":"csi","payload":{"seq":1,"ts_device_us":10,"channel":6,"rssi_dbm":-50,'
        '"noise_floor_dbm":-95,"sig_mode":1,"cwb":0,"secondary_channel":0,"stbc":0,'
        '"first_word_invalid":false,"payload_len":4,"raw_iq_int8":[1,2,3,4]}}',
        session_id="session-1",
        source_mode=SourceMode.LIVE,
    )
    assert message.message_type == "csi"
    assert message.payload.session_id == "session-1"
    assert message.payload.source_mode == SourceMode.LIVE
