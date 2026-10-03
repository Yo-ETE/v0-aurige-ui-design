"""AURIGE - Domaine CAN (init, scan-bitrate, stop, send, status). Extrait de main.py, routes inchangees."""
import asyncio
import json
import re
import subprocess
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import main

from main import CANInterfaceStatus

router = APIRouter()


class CANFrame(BaseModel):
    """Single CAN frame for sending"""
    interface: str = "can0"
    can_id: str = Field(alias="canId")  # Hex string like "7DF"
    data: str  # Hex string like "02010C" or "02 01 0C"

    class Config:
        populate_by_name = True


class CANInitRequest(BaseModel):
    interface: str = "can0"
    bitrate: int = 500000


class BitrateScanResult(BaseModel):
    bitrate: int
    bitrate_label: str
    frames_received: int
    errors: int
    unique_ids: int
    score: float  # 0-100


class BitrateScanResponse(BaseModel):
    interface: str
    results: list[BitrateScanResult]
    best_bitrate: Optional[int] = None
    best_score: float = 0.0
    scan_duration_ms: int


@router.get("/api/can/{interface}/status", response_model=CANInterfaceStatus)
async def get_can_status(interface: str):
    """Get status of a specific CAN interface"""
    if interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0, can1, or vcan0.")
    return main.get_can_interface_status(interface)


@router.post("/api/can/init")
async def initialize_can(request: CANInitRequest):
    """
    Initialize a CAN interface with specified bitrate.
    
    For physical interfaces (can0, can1):
    - ip link set canX down
    - ip link set canX type can bitrate BITRATE
    - ip link set canX up
    
    For virtual interface (vcan0):
    - modprobe vcan (load module)
    - ip link add dev vcan0 type vcan
    - ip link set up vcan0
    """
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    if request.interface == "vcan0":
        # Virtual CAN for testing - no bitrate needed
        try:
            subprocess.run(["modprobe", "vcan"], check=False)
            # Check if vcan0 already exists
            result = subprocess.run(["ip", "link", "show", "vcan0"], capture_output=True)
            if result.returncode != 0:
                subprocess.run(["ip", "link", "add", "dev", "vcan0", "type", "vcan"], check=True)
            subprocess.run(["ip", "link", "set", "up", "vcan0"], check=True)
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"Failed to initialize vcan0: {e}")
        return {
            "status": "initialized",
            "interface": "vcan0",
            "bitrate": 0,  # vcan has no bitrate
        }
    
    if request.bitrate not in [20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000]:
        raise HTTPException(status_code=400, detail="Invalid bitrate")
    
    main.can_interface_up(request.interface, request.bitrate)
    
    return {
        "status": "initialized",
        "interface": request.interface,
        "bitrate": request.bitrate,
    }


class BusIdentifyRequest(BaseModel):
    interface: str = "can0"
    durationSec: float = 2


# Seuils de l'heuristique de profil de bus (frames/s, sur la fenêtre observée).
_IDENTIFY_LOW_HZ = 50          # en dessous : bus peu actif (diag/infotainment)
_IDENTIFY_HIGH_HZ = 800        # au dessus : charge élevée (powertrain probable)
_IDENTIFY_LOW_ID_SHARE = 0.6   # part des trames en 0x000-0x3FF pour dire "IDs bas dominants"
_IDENTIFY_VARIED_MIN_IDS = 8   # nb d'IDs distincts pour parler de trafic "varié"


async def _candump_sample(interface: str, duration: float) -> list[str]:
    """Échantillonne candump -ta pendant `duration` s (LECTURE SEULE, ne touche pas au lien)."""
    proc = await asyncio.create_subprocess_exec(
        "candump", "-ta", interface,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    lines: list[str] = []
    loop = asyncio.get_event_loop()
    end_time = loop.time() + duration
    try:
        while loop.time() < end_time:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=max(0.05, end_time - loop.time()))
            except asyncio.TimeoutError:
                break
            if not line:
                break
            decoded = line.decode("utf-8", errors="ignore").strip()
            if decoded:
                lines.append(decoded)
    finally:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            proc.kill()
    return lines


def _estimate_bus_profile(frame_count: int, load_hz: float, ranges: dict, unique_ids: int) -> str:
    """Heuristique de profil de bus à partir de la charge et de la répartition des IDs."""
    if frame_count == 0:
        return "Aucun trafic — vérifiez câblage / terminaison 120Ω / bitrate"
    if load_hz < _IDENTIFY_LOW_HZ:
        return "diag/infotainment ou bus peu actif"
    low = ranges["0x000-0x0FF"] + ranges["0x100-0x3FF"]
    if load_hz > _IDENTIFY_HIGH_HZ and low / frame_count >= _IDENTIFY_LOW_ID_SHARE:
        return "powertrain probable (charge élevée, IDs bas)"
    populated = sum(1 for k in ("0x000-0x0FF", "0x100-0x3FF", "0x400-0x7FF", "extended") if ranges[k] > 0)
    if load_hz <= _IDENTIFY_HIGH_HZ and populated >= 2 and unique_ids >= _IDENTIFY_VARIED_MIN_IDS:
        return "body/confort probable"
    return "indéterminé"


@router.post("/api/can/identify")
async def identify_bus(request: BusIdentifyRequest):
    """
    Aide à identifier un bus inconnu : écoute passive (candump -ta, aucune émission,
    aucun changement de bitrate / état du lien) puis profil charge / IDs / estimation.
    """
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0, can1, or vcan0.")
    duration = max(0.5, min(10.0, float(request.durationSec)))
    if not main.get_can_interface_status(request.interface).up:
        raise HTTPException(status_code=400, detail="Interface down — initialisez-la d'abord (Contrôle CAN)")

    lines = await _candump_sample(request.interface, duration)

    ranges = {"0x000-0x0FF": 0, "0x100-0x3FF": 0, "0x400-0x7FF": 0, "extended": 0}
    counts: dict[str, int] = {}
    frame_count = 0
    for line in lines:
        m = re.search(r"\s([0-9A-Fa-f]+)#", line)
        if not m:
            continue
        raw = m.group(1)
        value = int(raw, 16)
        frame_count += 1
        # candump affiche 8 chiffres hex pour les IDs étendus (29 bits)
        if len(raw) > 3 or value > 0x7FF:
            ranges["extended"] += 1
        elif value <= 0xFF:
            ranges["0x000-0x0FF"] += 1
        elif value <= 0x3FF:
            ranges["0x100-0x3FF"] += 1
        else:
            ranges["0x400-0x7FF"] += 1
        key = raw.upper()
        counts[key] = counts.get(key, 0) + 1

    load_hz = round(frame_count / duration)
    top_ids = [{"id": i, "count": c} for i, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:10]]
    return {
        "status": "ok",
        "interface": request.interface,
        "durationSec": duration,
        "frameCount": frame_count,
        "uniqueIds": len(counts),
        "loadHz": load_hz,
        "idRanges": ranges,
        "topIds": top_ids,
        "estimate": _estimate_bus_profile(frame_count, load_hz, ranges, len(counts)),
    }


@router.post("/api/can/scan-bitrate")
async def scan_bitrate(interface: str = Query(default="can0"), timeout: float = Query(default=1.5)):
    """
    Auto-detect CAN bus bitrate by trying each common bitrate and scoring results.
    
    Algorithm:
    1. For each candidate bitrate: bring interface up, listen for frames
    2. Score based on: valid frames received, unique CAN IDs, error count
    3. Return all results sorted by score, with best bitrate highlighted
    """
    if interface not in ["can0", "can1"]:
        raise HTTPException(status_code=400, detail="Scan bitrate uniquement sur interfaces physiques (can0, can1)")
    
    candidate_bitrates = [
        (20000, "20 kbit/s"),
        (50000, "50 kbit/s"),
        (100000, "100 kbit/s"),
        (125000, "125 kbit/s"),
        (250000, "250 kbit/s"),
        (500000, "500 kbit/s"),
        (800000, "800 kbit/s"),
        (1000000, "1 Mbit/s"),
    ]
    
    results = []
    start_time = time.time()
    
    for bitrate, label in candidate_bitrates:
        # Bring interface down first
        main.run_command(["ip", "link", "set", interface, "down"], check=False)
        await asyncio.sleep(0.1)
        
        try:
            # Set bitrate and bring up
            main.run_command(["ip", "link", "set", interface, "type", "can", "bitrate", str(bitrate)])
            main.run_command(["ip", "link", "set", interface, "up"])
            await asyncio.sleep(0.1)
            
            # Listen with candump for timeout seconds
            proc = await asyncio.create_subprocess_exec(
                "candump", interface, "-t", "a",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            frames = []
            try:
                # Read frames with timeout
                end_time = asyncio.get_event_loop().time() + timeout
                while asyncio.get_event_loop().time() < end_time:
                    try:
                        line = await asyncio.wait_for(
                            proc.stdout.readline(),
                            timeout=max(0.1, end_time - asyncio.get_event_loop().time())
                        )
                        if line:
                            decoded = line.decode("utf-8", errors="ignore").strip()
                            if decoded:
                                frames.append(decoded)
                    except asyncio.TimeoutError:
                        break
            finally:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    proc.kill()
            
            # Parse frames and count unique IDs
            unique_ids = set()
            valid_frames = 0
            for frame in frames:
                match = re.search(r"([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", frame)
                if match:
                    valid_frames += 1
                    unique_ids.add(match.group(1).upper())
            
            # Get error count from interface stats
            err_count = 0
            try:
                stat_result = main.run_command(["ip", "-details", "-json", "link", "show", interface], check=False)
                if stat_result.returncode == 0:
                    stat_data = json.loads(stat_result.stdout)
                    if stat_data:
                        stats = stat_data[0].get("stats64", {})
                        err_count = stats.get("rx", {}).get("errors", 0) + stats.get("tx", {}).get("errors", 0)
            except Exception:
                pass
            
            # Score calculation
            score = 0.0
            if valid_frames > 0:
                # Base score: did we receive frames?
                score += min(40.0, valid_frames * 4.0)
                # Unique IDs bonus: more variety = more confident
                score += min(30.0, len(unique_ids) * 5.0)
                # Low errors bonus
                if err_count == 0:
                    score += 20.0
                elif err_count < 5:
                    score += 10.0
                # Consistency bonus: high frame count relative to time
                frames_per_sec = valid_frames / timeout
                if frames_per_sec > 10:
                    score += 10.0
                elif frames_per_sec > 5:
                    score += 5.0
            
            score = min(100.0, score)
            
            results.append(BitrateScanResult(
                bitrate=bitrate,
                bitrate_label=label,
                frames_received=valid_frames,
                errors=err_count,
                unique_ids=len(unique_ids),
                score=round(score, 1),
            ))
            
        except Exception:
            results.append(BitrateScanResult(
                bitrate=bitrate,
                bitrate_label=label,
                frames_received=0,
                errors=0,
                unique_ids=0,
                score=0.0,
            ))
        
        # Bring down after test
        main.run_command(["ip", "link", "set", interface, "down"], check=False)
    
    # Sort by score descending
    results.sort(key=lambda r: -r.score)
    
    best = results[0] if results and results[0].score > 0 else None
    scan_ms = int((time.time() - start_time) * 1000)
    
    return BitrateScanResponse(
        interface=interface,
        results=results,
        best_bitrate=best.bitrate if best else None,
        best_score=best.score if best else 0.0,
        scan_duration_ms=scan_ms,
    )


@router.post("/api/can/stop")
async def stop_can(interface: str = Query(default="can0")):
    """Stop a CAN interface"""
    if interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    main.can_interface_down(interface)
    
    return {"status": "stopped", "interface": interface}


@router.post("/api/can/send")
async def send_can_frame(frame: CANFrame):
    """
    Send a single CAN frame.
    
    Executes: cansend canX ID#DATA
    """
    if frame.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    success, error = main.can_send_frame(frame.interface, frame.can_id, frame.data)
    
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to send frame: {error}")
    
    return {
        "status": "sent",
        "interface": frame.interface,
        "canId": frame.can_id,
        "data": frame.data,
    }
