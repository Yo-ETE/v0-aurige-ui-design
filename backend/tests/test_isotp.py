"""ISO-TP multi-frame : obd_send_with_flow_control attend la first frame avant le FC,
collecte tous les consecutive frames (corrige le VIN tronque)."""
import asyncio

import pytest

import main


class _FakeStdout:
    def __init__(self, lines, delay=0.03):
        self._lines = list(lines)
        self._delay = delay

    async def readline(self):
        if self._lines:
            await asyncio.sleep(self._delay)
            return (self._lines.pop(0) + "\n").encode()
        await asyncio.sleep(3600)  # bloque jusqu'a annulation
        return b""


class _FakeProc:
    def __init__(self, lines):
        self.stdout = _FakeStdout(lines)
        self.returncode = None

    def terminate(self):
        pass

    def kill(self):
        pass

    async def wait(self):
        return 0


def test_multiframe_vin_collects_all_frames(monkeypatch):
    # Reponse VIN (Mode 09 PID 02) sur 7E8 : first frame (len 0x014=20) + 2 consecutive frames.
    frames = [
        "(0.0) can0 7E8#101449020157304C",  # 10 14 | 49 02 01 | 57 30 4C
        "(0.1) can0 7E8#2156353538323639",  # 21 ...
        "(0.2) can0 7E8#2231323334353637",  # 22 ... -> total 20 octets atteint
    ]
    sent = []
    monkeypatch.setattr(main, "can_send_frame", lambda iface, cid, data: (sent.append((cid, data)) or (True, "")))

    async def fake_exec(*a, **k):
        return _FakeProc(frames)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(main.obd_send_with_flow_control("can0", "7E0", "0209020000000000", "7E8"))
    assert result["success"] is True
    got = [ln for ln in result["responses"] if "7E8#" in ln]
    assert len(got) == 3  # first frame + 2 consecutive frames tous captures
    # Flow control envoye vers 7E0 (= 7E8 - 8) apres la first frame
    assert ("7E0", "3000000000000000") in sent
    # Le VIN se decode entierement (17 caracteres)
    vin = main.decode_vin_from_frames(result["responses"])
    assert len(vin) == 17


def test_single_frame_no_flow_control(monkeypatch):
    # Reponse single frame (ex compteur DTC) : pas de FC, retour rapide.
    frames = ["(0.0) can0 7E8#0341010000000000"]  # 03 41 01 ... single frame
    sent = []
    monkeypatch.setattr(main, "can_send_frame", lambda iface, cid, data: (sent.append((cid, data)) or (True, "")))

    async def fake_exec(*a, **k):
        return _FakeProc(frames)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(main.obd_send_with_flow_control("can0", "7E0", "0201000000000000", "7E8"))
    assert result["success"] is True
    # Aucun flow control envoye (pas de first frame)
    assert all(d != "3000000000000000" for _, d in sent)


def test_send_failure_returns_error(monkeypatch):
    monkeypatch.setattr(main, "can_send_frame", lambda iface, cid, data: (False, "no iface"))

    async def fake_exec(*a, **k):
        return _FakeProc([])

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(main.obd_send_with_flow_control("can0", "7E0", "0209020000000000", "7E8"))
    assert result["success"] is False and result["error"]
