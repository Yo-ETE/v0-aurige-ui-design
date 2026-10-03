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
