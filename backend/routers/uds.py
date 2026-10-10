"""AURIGE - Panneau UDS (ISO 14229) : requête UDS générique sur ISO-TP.

Diagnostic avancé / test d'actionneurs sur le propre véhicule de l'utilisateur. L'ISO-TP réception
est géré par `main.obd_send_with_flow_control` ; le framing single-frame + décodage NRC par
`uds_client`. Injection bus → garde `can_inject` (permissions) + confirmation côté UI sur les
services d'action. Les helpers restent dans main.py (appelés via main.<nom>).
"""
import asyncio
import re
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import main
import uds_client

router = APIRouter()

_IFACES = {"can0", "can1", "vcan0"}
_ID_RE = re.compile(r"^[0-9A-Fa-f]{1,8}$")
_SERVICE_RE = re.compile(r"^[0-9A-Fa-f]{2}$")
_DATA_RE = re.compile(r"^([0-9A-Fa-f]{2})*$")


class UDSRequest(BaseModel):
    interface: str = "can0"
    request_id: str
    response_id: str = "7E8"
    service: str
    data: str = ""


_DID_RE = re.compile(r"^[0-9A-Fa-f]{2,8}$")


class UDSDidCreate(BaseModel):
    did: str
    name: str
    brand: str = ""
    ecu_request_id: str = "7E0"
    ecu_response_id: str = "7E8"
    note: str = ""


class UDSDidPatch(BaseModel):
    did: Optional[str] = None
    name: Optional[str] = None
    brand: Optional[str] = None
    ecu_request_id: Optional[str] = None
    ecu_response_id: Optional[str] = None
    note: Optional[str] = None


def _check_did(did: str) -> None:
    if not _DID_RE.match(did) or len(did) % 2 != 0:
        raise HTTPException(status_code=400, detail="did hex requis (1 a 4 octets, longueur paire)")


def _check_ecu(v: str) -> None:
    if not _ID_RE.match(v):
        raise HTTPException(status_code=400, detail="ID ECU hex 1..8 requis")


@router.get("/api/uds/dids")
async def uds_dids_list():
    return {"dids": main._load_dids()}


@router.post("/api/uds/dids")
async def uds_dids_create(req: UDSDidCreate):
    _check_did(req.did)
    _check_ecu(req.ecu_request_id)
    _check_ecu(req.ecu_response_id)
    obj = {
        "id": uuid.uuid4().hex,
        "did": req.did.upper(),
        "name": req.name,
        "brand": req.brand,
        "ecu_request_id": req.ecu_request_id.upper(),
        "ecu_response_id": req.ecu_response_id.upper(),
        "note": req.note,
    }
    dids = main._load_dids()
    dids.append(obj)
    main._save_dids(dids)
    return {"status": "ok", "did": obj}


@router.patch("/api/uds/dids/{did_id}")
async def uds_dids_patch(did_id: str, req: UDSDidPatch):
    dids = main._load_dids()
    target = next((d for d in dids if d.get("id") == did_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="DID introuvable")
    if req.did is not None:
        _check_did(req.did)
        target["did"] = req.did.upper()
    if req.ecu_request_id is not None:
        _check_ecu(req.ecu_request_id)
        target["ecu_request_id"] = req.ecu_request_id.upper()
    if req.ecu_response_id is not None:
        _check_ecu(req.ecu_response_id)
        target["ecu_response_id"] = req.ecu_response_id.upper()
    for k in ("name", "brand", "note"):
        v = getattr(req, k)
        if v is not None:
            target[k] = v
    main._save_dids(dids)
    return {"status": "ok", "did": target}


@router.delete("/api/uds/dids/{did_id}")
async def uds_dids_delete(did_id: str):
    dids = main._load_dids()
    kept = [d for d in dids if d.get("id") != did_id]
    if len(kept) == len(dids):
        raise HTTPException(status_code=404, detail="DID introuvable")
    main._save_dids(kept)
    return {"status": "ok"}


@router.post("/api/uds/request")
async def uds_request(req: UDSRequest):
    # Validation stricte (interface + IDs + service + data hex)
    if req.interface not in _IFACES:
        raise HTTPException(status_code=400, detail="Interface invalide (can0/can1/vcan0)")
    if not _ID_RE.match(req.request_id) or not _ID_RE.match(req.response_id):
        raise HTTPException(status_code=400, detail="request_id/response_id hex 1..8 requis")
    if not _SERVICE_RE.match(req.service):
        raise HTTPException(status_code=400, detail="service = 1 octet hex")
    if not _DATA_RE.match(req.data or ""):
        raise HTTPException(status_code=400, detail="data doit etre une suite d'octets hex")

    try:
        frame = uds_client.build_single_frame(req.service, req.data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    result = await main.obd_send_with_flow_control(
        req.interface, req.request_id.upper(), frame, req.response_id.upper()
    )
    if not result.get("success"):
        return {"status": "error", "error": result.get("error") or "transport"}

    # Filtre les trames reçues sur le response_id attendu, puis décode.
    rid = req.response_id.upper()
    frames = []
    for line in result.get("responses") or []:
        parsed = main.parse_candump_line(line)
        if parsed and parsed["id"] == rid:
            frames.append(parsed["data"])
    response = uds_client.decode_response(frames)
    return {
        "status": "ok",
        "request": {
            "interface": req.interface,
            "request_id": req.request_id.upper(),
            "response_id": rid,
            "service": req.service.upper(),
            "data": (req.data or "").upper(),
        },
        "response": response,
    }


# Motifs d'une reponse TesterPresent (3E) : data hex majuscule, sans separateur.
_UDS_POS = "027E00"   # positive : PCI 02, 7E (=0x3E+0x40), sous-fonction 00
_UDS_NEG = "037F3E"   # negative : PCI 03, 7F, service 3E, puis NRC


class UDSScanRequest(BaseModel):
    interface: str = "can0"
    start_id: str = "700"
    end_id: str = "7FF"
    service: str = "3E"
    data: str = "00"
    gap_ms: int = 40
    listen_ms: int = 90


@router.post("/api/uds/scan")
async def uds_scan(req: UDSScanRequest):
    """Balaye une plage de request IDs en TesterPresent et detecte les ECU qui repondent.

    TesterPresent (3E 00) n'actionne rien : sert a reperer les adresses UDS presentes sur le bus.
    Balayage = injection multi-ID -> is_id_blocked applique par ID (comme fuzzing/generator).
    """
    if req.interface not in _IFACES:
        raise HTTPException(status_code=400, detail="Interface invalide (can0/can1/vcan0)")
    if not _ID_RE.match(req.start_id) or not _ID_RE.match(req.end_id):
        raise HTTPException(status_code=400, detail="start_id/end_id hex 1..8 requis")
    if not _SERVICE_RE.match(req.service):
        raise HTTPException(status_code=400, detail="service = 1 octet hex")
    if not _DATA_RE.match(req.data or ""):
        raise HTTPException(status_code=400, detail="data doit etre une suite d'octets hex")
    start = int(req.start_id, 16)
    end = int(req.end_id, 16)
    if end < start:
        raise HTTPException(status_code=400, detail="end_id doit etre >= start_id")
    if (end - start + 1) > 512:
        raise HTTPException(status_code=400, detail="Plage trop large (max 512 IDs)")
    try:
        frame = uds_client.build_single_frame(req.service, req.data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    gap = min(max(req.gap_ms, 10), 500) / 1000.0
    listen = min(max(req.listen_ms, 10), 500) / 1000.0

    started = time.time()
    responders = []
    seen = set()
    scanned = 0
    blocked = 0

    # Un seul candump pour tout le scan ; lecture temps reel via PIPE.
    candump = None
    reader_task = None
    lines: list[str] = []
    try:
        candump = await asyncio.create_subprocess_exec(
            "candump", "-L", "-ta", req.interface,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )

        async def _reader():
            assert candump.stdout is not None
            while True:
                raw = await candump.stdout.readline()
                if not raw:
                    break
                lines.append(raw.decode("utf-8", "replace").strip())

        reader_task = asyncio.create_task(_reader())
        await asyncio.sleep(0.15)  # laisser candump demarrer

        for v in range(start, end + 1):
            rid = f"{v:03X}"
            if main.is_id_blocked(rid):
                blocked += 1
                continue
            mark = len(lines)
            main.can_send_frame(req.interface, rid, frame)
            scanned += 1
            await asyncio.sleep(listen)
            for line in lines[mark:]:
                parsed = main.parse_candump_line(line)
                if not parsed:
                    continue
                d = parsed["data"]
                if d.startswith(_UDS_POS) or d.startswith(_UDS_NEG):
                    key = (rid, parsed["id"])
                    if key in seen:
                        continue
                    seen.add(key)
                    responders.append({
                        "request_id": rid,
                        "response_id": parsed["id"],
                        "kind": "positive" if d.startswith(_UDS_POS) else "negative",
                        "data": d,
                    })
            await asyncio.sleep(gap)
    finally:
        if reader_task:
            reader_task.cancel()
        if candump:
            candump.terminate()
            try:
                await asyncio.wait_for(candump.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                candump.kill()

    return {
        "status": "ok",
        "interface": req.interface,
        "scanned": scanned,
        "blocked_skipped": blocked,
        "responders": responders,
        "elapsed_ms": round((time.time() - started) * 1000, 1),
    }


# Motifs d'une reponse a ReadDataByIdentifier (0x22) : data hex majuscule.
_DID_POS = "62"        # 0x22 + 0x40 = reponse positive
_DID_NRC_UNSUPPORTED = "7F2231"  # requestOutOfRange = DID non supporte
_DID_NRC_PREFIX = "7F22"         # autre NRC sur le service 22 (ex 33 = verrouille)
_DID_RE = re.compile(r"^[0-9A-Fa-f]{1,4}$")


class UDSScanDidsRequest(BaseModel):
    interface: str = "can0"
    request_id: str = "7E0"
    response_id: str = "7E8"
    start_did: str = "F100"
    end_did: str = "F1FF"
    gap_ms: int = 30
    listen_ms: int = 80


@router.post("/api/uds/scan-dids")
async def uds_scan_dids(req: UDSScanDidsRequest):
    """Enumere les DID (ReadDataByIdentifier 0x22) supportes par UN ECU.

    Pour chaque DID de la plage : envoie 22 <DID>, detecte 62=supporte / 7F2231=non supporte /
    7F22xx=present mais autre NRC (ex 33 verrouille). Lecture seule (0x22) mais TX sur l'ECU ->
    garde can_inject + is_id_blocked sur le request_id.
    """
    if req.interface not in _IFACES:
        raise HTTPException(status_code=400, detail="Interface invalide (can0/can1/vcan0)")
    if not _ID_RE.match(req.request_id) or not _ID_RE.match(req.response_id):
        raise HTTPException(status_code=400, detail="request_id/response_id hex 1..8 requis")
    if not _DID_RE.match(req.start_did) or not _DID_RE.match(req.end_did):
        raise HTTPException(status_code=400, detail="start_did/end_did hex 1..4 requis")
    start = int(req.start_did, 16)
    end = int(req.end_did, 16)
    if end < start:
        raise HTTPException(status_code=400, detail="end_did doit etre >= start_did")
    if (end - start + 1) > 1024:
        raise HTTPException(status_code=400, detail="Plage trop large (max 1024 DID)")
    if main.is_id_blocked(req.request_id):
        raise HTTPException(status_code=403, detail=f"ID {req.request_id.upper()} bloque (AUD-06)")

    gap = min(max(req.gap_ms, 10), 500) / 1000.0
    listen = min(max(req.listen_ms, 10), 500) / 1000.0
    rid = req.response_id.upper()
    req_id = req.request_id.upper()

    started = time.time()
    supported = []
    seen = set()
    scanned = 0
    unsupported = 0

    candump = None
    reader_task = None
    lines: list[str] = []
    try:
        candump = await asyncio.create_subprocess_exec(
            "candump", "-L", "-ta", req.interface,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )

        async def _reader():
            assert candump.stdout is not None
            while True:
                raw = await candump.stdout.readline()
                if not raw:
                    break
                lines.append(raw.decode("utf-8", "replace").strip())

        reader_task = asyncio.create_task(_reader())
        await asyncio.sleep(0.15)

        for v in range(start, end + 1):
            did = f"{v:04X}"
            frame = uds_client.build_single_frame("22", did)
            mark = len(lines)
            main.can_send_frame(req.interface, req_id, frame)
            scanned += 1
            await asyncio.sleep(listen)
            for line in lines[mark:]:
                parsed = main.parse_candump_line(line)
                if not parsed or parsed["id"] != rid:
                    continue
                d = parsed["data"]
                if did in seen or len(d) < 2:
                    if did in seen:
                        break
                    continue
                # Strip le PCI ISO-TP pour obtenir la charge utile UDS.
                pci = int(d[0:2], 16) >> 4
                if pci == 0x0:        # single frame : 1 octet de PCI
                    payload = d[2:]
                elif pci == 0x1:      # first frame : 2 octets de PCI
                    payload = d[4:]
                else:
                    continue
                if payload.startswith(_DID_POS):
                    seen.add(did)
                    supported.append({"did": did, "kind": "positive", "data": d})
                    break
                if payload.startswith(_DID_NRC_UNSUPPORTED):
                    unsupported += 1
                    seen.add(did)
                    break
                if payload.startswith(_DID_NRC_PREFIX):
                    # present mais autre NRC (ex 33 = verrouille SecurityAccess)
                    nrc = payload[4:6] if len(payload) >= 6 else ""
                    seen.add(did)
                    supported.append({"did": did, "kind": "locked", "data": d, "nrc": nrc})
                    break
            await asyncio.sleep(gap)
    finally:
        if reader_task:
            reader_task.cancel()
        if candump:
            candump.terminate()
            try:
                await asyncio.wait_for(candump.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                candump.kill()

    return {
        "status": "ok",
        "interface": req.interface,
        "request_id": req_id,
        "response_id": rid,
        "scanned": scanned,
        "unsupported": unsupported,
        "supported": supported,
        "elapsed_ms": round((time.time() - started) * 1000, 1),
    }
