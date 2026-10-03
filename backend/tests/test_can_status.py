"""Statut interface CAN : etat controleur + compteurs d'erreurs bus."""

import json
from types import SimpleNamespace

import main


def _fake(payload, rc=0):
    return lambda *a, **k: SimpleNamespace(returncode=rc, stdout=json.dumps(payload), stderr="")


STATS = {"rx": {"packets": 10, "errors": 1}, "tx": {"packets": 5, "errors": 2}}


def test_bus_off_state_and_counters(monkeypatch):
    payload = [{
        "operstate": "DOWN", "flags": ["NOARP", "UP", "LOWER_UP"],
        "linkinfo": {"info_data": {
            "state": "bus-off", "berr_counter": {"tx": 255, "rx": 128},
            "restart_cnt": 3, "bittiming": {"bitrate": 500000}}},
        "stats64": STATS,
    }]
    monkeypatch.setattr(main, "run_command", _fake(payload))
    st = main.get_can_interface_status("can0")
    assert st.can_state == "BUS-OFF"
    assert st.berr_tx == 255 and st.berr_rx == 128 and st.restarts == 3
    assert st.bitrate == 500000
    assert st.errors == 3 and st.tx_packets == 5 and st.rx_packets == 10


def test_vcan_has_no_state(monkeypatch):
    payload = [{"operstate": "UNKNOWN", "flags": ["NOARP", "UP"], "linkinfo": {}, "stats64": STATS}]
    monkeypatch.setattr(main, "run_command", _fake(payload))
    st = main.get_can_interface_status("vcan0")
    assert st.up is True
    assert st.can_state is None and st.berr_tx is None and st.berr_rx is None and st.restarts is None
