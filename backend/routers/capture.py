"""AURIGE - Domaine capture (start, stop, status). Multi-bus simultane : un slot par interface."""
import asyncio
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import main

router = APIRouter()

# Interfaces autorisees pour la capture (lecture seule, aucune emission)
CAPTURE_INTERFACES = {"can0", "can1", "vcan0"}


class CaptureStartRequest(BaseModel):
    interface: str = "can0"
    mission_id: str = Field(alias="missionId")
    filename: Optional[str] = None
    description: Optional[str] = None

    class Config:
        populate_by_name = True


class CaptureStopRequest(BaseModel):
    interface: Optional[str] = None


def _is_live(slot: Optional[dict]) -> bool:
    """Un slot est vivant si son process candump tourne encore."""
    return bool(slot) and slot["process"].returncode is None


def _live_slots() -> dict:
    return {i: s for i, s in main.state.captures.items() if _is_live(s)}


@router.post("/api/capture/start")
async def start_capture(request: CaptureStartRequest):
    """
    Demarre une capture CAN vers un fichier log (une capture par interface).

    Execute : candump -L canX > mission/logs/filename.log
    """
    if request.interface not in CAPTURE_INTERFACES:
        raise HTTPException(status_code=400, detail=f"Interface invalide : {request.interface}")

    # 409 uniquement si CETTE interface capture deja
    if _is_live(main.state.captures.get(request.interface)):
        raise HTTPException(status_code=409, detail=f"Capture deja en cours sur {request.interface}")

    # Verify mission exists
    main.load_mission(request.mission_id)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = request.filename or f"capture_{timestamp}_{request.interface}.log"
    if not filename.endswith(".log"):
        filename += ".log"

    logs_dir = main.get_mission_logs_dir(request.mission_id)
    log_path = logs_dir / filename

    # candump -L : format log rejouable par canplayer.
    # stdbuf -oL force un buffer ligne par ligne : sans lui, la sortie vers un
    # fichier est bufferisee par bloc et le compteur de trames "live" (wc -l)
    # resterait a 0 jusqu'a l'arret.
    fh = open(log_path, "w")
    try:
        process = await asyncio.create_subprocess_exec(
            "stdbuf", "-oL", "candump", "-L", request.interface,
            stdout=fh,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception:
        fh.close()
        raise
    start_time = datetime.now()
    main.state.captures[request.interface] = {
        "process": process,
        "file": log_path,
        "start_time": start_time,
        "fh": fh,
    }

    # Bitrate courant de l'interface (None si inconnu / vcan)
    try:
        bitrate = main.get_can_interface_status(request.interface).bitrate
    except Exception:
        bitrate = None

    meta_path = log_path.with_suffix(".meta.json")
    with open(meta_path, "w") as f:
        json.dump({
            "description": request.description,
            "interface": request.interface,
            "bitrate": bitrate,
            "startTime": start_time.isoformat(),
        }, f)

    return {
        "status": "started",
        "missionId": request.mission_id,
        "filename": filename,
        "interface": request.interface,
    }


@router.post("/api/capture/stop")
async def stop_capture(interface: Optional[str] = None, body: Optional[CaptureStopRequest] = None):
    """Arrete une capture. Interface en query (?interface=) ou en corps JSON {interface}."""
    iface = interface or (body.interface if body else None)
    live = _live_slots()

    if iface is None:
        if len(live) == 1:
            iface = next(iter(live))
        elif len(live) == 0:
            raise HTTPException(status_code=404, detail="Aucune capture en cours")
        else:
            raise HTTPException(status_code=400, detail="Préciser l'interface")
    elif iface not in live:
        raise HTTPException(status_code=404, detail=f"Aucune capture en cours sur {iface}")

    slot = live[iface]
    process = slot["process"]
    log_path = slot["file"]

    duration = int((datetime.now() - slot["start_time"]).total_seconds())

    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        process.kill()

    # Ferme le descripteur du fichier log (jamais ferme auparavant)
    try:
        slot["fh"].close()
    except Exception:
        pass

    # Mise a jour des metadonnees (duree, fin)
    meta_path = log_path.with_suffix(".meta.json")
    if meta_path.exists():
        with open(meta_path, "r") as f:
            meta = json.load(f)
        meta["durationSeconds"] = duration
        meta["endTime"] = datetime.now().isoformat()
        with open(meta_path, "w") as f:
            json.dump(meta, f)

    mission_id = log_path.parent.parent.name
    main.update_mission_stats(mission_id, new_capture=True)

    filename = log_path.name
    frames_count = main._count_log_frames(log_path)

    main.state.captures.pop(iface, None)

    return {
        "status": "stopped",
        "filename": filename,
        "durationSeconds": duration,
        "framesCount": frames_count,
    }


@router.get("/api/capture/status")
async def get_capture_status():
    """Liste les captures en cours (une entree par interface)."""
    now = datetime.now()
    captures = []
    for iface, slot in _live_slots().items():
        captures.append({
            "interface": iface,
            "running": True,
            "filename": slot["file"].name,
            "durationSeconds": int((now - slot["start_time"]).total_seconds()),
            "framesCount": main._count_log_frames(slot["file"]),
        })
    return {"captures": captures}
