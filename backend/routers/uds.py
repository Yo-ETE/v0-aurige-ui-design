"""AURIGE - Panneau UDS (ISO 14229) : requête UDS générique sur ISO-TP.

Diagnostic avancé / test d'actionneurs sur le propre véhicule de l'utilisateur. L'ISO-TP réception
est géré par `main.obd_send_with_flow_control` ; le framing single-frame + décodage NRC par
`uds_client`. Injection bus → garde `can_inject` (permissions) + confirmation côté UI sur les
services d'action. Les helpers restent dans main.py (appelés via main.<nom>).
"""
import re

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
