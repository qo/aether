"""Smoke tests for the new v0.2 routes.

These don't bring up a serial port; the runtime ticks over with whatever
LinkStats has (zeroes when no frames have arrived). The intent is to catch
regressions in route shape — what the UI relies on — before they reach
the browser.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from apps.api.src.api.routes import build_router
from apps.api.src.services.runtime import RuntimeState
from apps.api.src.services.session_store import SessionStore
from fastapi import FastAPI


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    store = SessionStore(tmp_path / "aether.sqlite", tmp_path)
    state = RuntimeState(store=store)
    app = FastAPI()
    app.include_router(build_router(state))
    return TestClient(app)


def test_diagnostics_link_returns_nulls_before_any_frames(client: TestClient) -> None:
    response = client.get("/diagnostics/link")
    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "link_diagnostics.v1"
    # observed_packet_rate_hz must be None (not 0.0) when nothing has been
    # seen — 0 would be mistaken for a measurement.
    assert body["observed_packet_rate_hz"] is None
    assert body["frames_seen"] == 0
    assert body["rate_stable"] is False
    # No RSSI yet -> distance estimate is None, not a hallucinated number.
    assert body["rssi_implied_distance_m"] is None
    # No frames -> no inter-arrival or RSSI numbers either.
    assert body["inter_arrival_p50_ms"] is None
    assert body["rssi_p50_dbm"] is None


def test_diagnostics_subcarriers_returns_empty_until_calibrated(client: TestClient) -> None:
    response = client.get("/diagnostics/subcarriers")
    assert response.status_code == 200
    body = response.json()
    assert body["is_calibrated"] is False
    assert body["amplitude_mean"] == []
    assert body["responsive_indices"] == []


def test_room_geometry_get_starts_with_no_positions(client: TestClient) -> None:
    response = client.get("/room/geometry")
    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "room_geometry.v1"
    # No defaults — every position is null until the operator saves real values.
    assert body["room_extent_m"] is None
    assert body["tx_position_m"] is None
    assert body["rx_position_m"] is None
    assert body["subject_position_m"] is None
    assert body["is_complete"] is False
    assert body["updated_ns"] == 0


def test_room_geometry_put_then_get_round_trips(client: TestClient) -> None:
    payload = {
        "schema_version": "room_geometry.v1",
        "room_extent_m": [3.2, 2.4, 2.5],
        "tx_position_m": [0.3, 1.2, 0.5],
        "rx_position_m": [3.0, 1.2, 1.8],
        "tx_orientation_deg": 0.0,
        "rx_orientation_deg": 0.0,
        "subject_position_m": [1.5, 1.0, 1.2],
        "subject_radius_m": 0.4,
        "notes": "test room",
        "updated_ns": 0,
    }
    put_resp = client.put("/room/geometry", json=payload)
    assert put_resp.status_code == 200
    saved = put_resp.json()
    assert saved["room_extent_m"] == [3.2, 2.4, 2.5]
    assert saved["updated_ns"] > 0
    assert saved["is_complete"] is True

    get_resp = client.get("/room/geometry")
    assert get_resp.status_code == 200
    fetched = get_resp.json()
    assert fetched["room_extent_m"] == [3.2, 2.4, 2.5]
    assert fetched["is_complete"] is True


def test_room_geometry_put_partial_marks_incomplete(client: TestClient) -> None:
    """Saving room dimensions but no TX/RX should keep is_complete=false."""
    payload = {
        "schema_version": "room_geometry.v1",
        "room_extent_m": [3.0, 2.5, 4.0],
        "tx_position_m": None,
        "rx_position_m": None,
        "tx_orientation_deg": 0.0,
        "rx_orientation_deg": 0.0,
        "subject_position_m": None,
        "subject_radius_m": 0.35,
        "notes": None,
        "updated_ns": 0,
    }
    put_resp = client.put("/room/geometry", json=payload)
    assert put_resp.status_code == 200
    saved = put_resp.json()
    assert saved["is_complete"] is False
    assert saved["room_extent_m"] == [3.0, 2.5, 4.0]
    assert saved["tx_position_m"] is None


def test_session_frames_404_for_unknown_session(client: TestClient) -> None:
    response = client.get("/sessions/does-not-exist/frames")
    assert response.status_code == 404


def test_rssi_implied_distance_helper_returns_sane_range() -> None:
    from apps.api.src.api.routes import _rssi_implied_distance_m

    assert _rssi_implied_distance_m(None) is None
    # -30 dBm is a strong signal — should imply 1-2 m at the n=3 indoor model.
    near = _rssi_implied_distance_m(-30)
    assert near is not None and 1.0 < near < 3.0
    # -45 dBm is typical for a few metres' separation indoors.
    medium = _rssi_implied_distance_m(-45)
    assert medium is not None and 3.0 < medium < 10.0
    # -110 dBm is well below the noise floor; the helper refuses to invent
    # a number rather than returning a hallucination.
    nonsense = _rssi_implied_distance_m(-110)
    assert nonsense is None


def test_session_frames_returns_empty_for_session_with_no_recordings(
    client: TestClient, tmp_path: Path
) -> None:
    create = client.post("/sessions", json={"protocol": "smoke"})
    assert create.status_code == 200
    sid = create.json()["session_id"]
    response = client.get(f"/sessions/{sid}/frames")
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 0
    assert body["frames"] == []
