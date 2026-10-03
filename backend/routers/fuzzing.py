"""AURIGE - Domaine fuzzing (start, stop, status, force-cleanup, crash-recovery, history,
analyze-crash, compare-logs). Extrait de main.py, routes inchangees."""
import asyncio
import json
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import main

router = APIRouter()


class FuzzingRequest(BaseModel):
    interface: str = "can0"
    id_start: str = Field(alias="idStart")  # Hex
    id_end: str = Field(alias="idEnd")  # Hex
    data_template: str = Field(alias="dataTemplate", default="")  # Hex (used in static mode)
    iterations: int = 100
    delay_ms: float = Field(alias="delayMs", default=10)
    
    # Data generation mode: "static" | "random" | "range" | "logs"
    data_mode: str = Field(alias="dataMode", default="random")
    
    # For "range" mode: per-byte min/max constraints
    byte_ranges: Optional[list] = Field(alias="byteRanges", default=None)
    
    # For "logs" mode: replay observed data from mission logs
    mission_id: Optional[str] = Field(alias="missionId", default=None)
    log_id: Optional[str] = Field(alias="logId", default=None)
    
    # For single-ID targeted fuzzing
    target_ids: Optional[list] = Field(alias="targetIds", default=None)
    
    # DLC (data length code)
    dlc: int = 8
    
    # Crash detection & recovery
    enable_crash_detection: bool = Field(alias="enableCrashDetection", default=True)
    enable_pre_fuzz_capture: bool = Field(alias="enablePreFuzzCapture", default=True)
    pre_fuzz_duration_sec: int = Field(alias="preFuzzDurationSec", default=5)

    class Config:
        populate_by_name = True


class CrashRecoveryRequest(BaseModel):
    """Request to attempt crash recovery"""
    interface: str = "can0"
    suspect_ids: Optional[list] = Field(alias="suspectIds", default=None)  # IDs to try reset on
    
    class Config:
        populate_by_name = True


@router.post("/api/fuzzing/start")
async def start_fuzzing(request: FuzzingRequest):
    """
    Start fuzzing with smart data generation modes:
    - static: send same data_template for all frames
    - random: random bytes for each frame (true fuzzing)
    - range: random bytes within per-byte min/max from log analysis
    - logs: replay actual observed data from mission logs, varying byte by byte
    """
    if main.state.fuzzing_process and main.state.fuzzing_process.returncode is None:
        raise HTTPException(status_code=409, detail="Fuzzing already running")
    
    # Validate inputs
    if not re.match(r'^[0-9A-Fa-f]{1,8}$', request.id_start):
        raise HTTPException(status_code=400, detail=f"ID start invalide: {request.id_start}")
    if not re.match(r'^[0-9A-Fa-f]{1,8}$', request.id_end):
        raise HTTPException(status_code=400, detail=f"ID end invalide: {request.id_end}")
    if request.data_template and not re.match(r'^[0-9A-Fa-f]*$', request.data_template):
        raise HTTPException(status_code=400, detail=f"Data template invalide: {request.data_template}")
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    if not (1 <= request.iterations <= 100000):
        raise HTTPException(status_code=400, detail="Iterations must be between 1 and 100000")
    if not (0.1 <= request.delay_ms <= 10000):
        raise HTTPException(status_code=400, detail="Delay must be between 0.1ms and 10000ms")
    
    dlc = max(1, min(request.dlc, 8))
    mode = request.data_mode

    # AUD-06 : liste effective d'IDs cibles, sans les IDs critiques
    blocked_skipped = 0
    filtered_targets = None  # None = balayage de plage inchange
    if request.target_ids:
        norm_targets = [main._norm_id(t) for t in request.target_ids]
        filtered_targets = [t for t in norm_targets if not main.is_id_blocked(t)]
        blocked_skipped = len(norm_targets) - len(filtered_targets)
        if not filtered_targets:
            raise HTTPException(status_code=403, detail="Tous les IDs cibles sont bloques (AUD-06)")
    else:
        r_start = int(request.id_start, 16)
        r_end = int(request.id_end, 16)
        if r_end < r_start:
            r_start, r_end = r_end, r_start
        size = r_end - r_start + 1
        # Les IDs bloques de la plage (pilote par la liste, pas par la plage)
        blocked_in_range = sorted({
            v for v in (main._id_int(b) for b in main._load_blocklist())
            if v is not None and r_start <= v <= r_end and main.is_id_blocked("{:03X}".format(v))
        })
        if blocked_in_range:
            blocked_skipped = len(blocked_in_range)
            if blocked_skipped >= size:
                raise HTTPException(status_code=403, detail="Tous les IDs cibles sont bloques (AUD-06)")
            # Expansion bornee par le nombre d'iterations (le script cycle dessus)
            blocked_set = set(blocked_in_range)
            want = min(request.iterations, size - blocked_skipped)
            filtered_targets = []
            cur = r_start
            while len(filtered_targets) < want and cur <= r_end:
                if cur not in blocked_set:
                    filtered_targets.append("{:03X}".format(cur))
                cur += 1
    
    # PRE-FUZZ CAPTURE: Record baseline traffic before fuzzing
    pre_fuzz_log_path = None
    if request.enable_pre_fuzz_capture and request.mission_id:
        try:
            from datetime import datetime
            logs_dir = main.get_mission_logs_dir(request.mission_id)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            pre_fuzz_log_path = logs_dir / f"pre_fuzz_{timestamp}.log"
            
            # Run candump for N seconds to capture baseline
            duration = request.pre_fuzz_duration_sec
            candump_cmd = [
                "timeout", str(duration),
                "candump", request.interface,
                "-L"
            ]
            
            with open(pre_fuzz_log_path, "w") as log_f:
                result = main.run_command(candump_cmd, check=False, stdout=log_f)
            
            # Create metadata
            meta_path = logs_dir / f"pre_fuzz_{timestamp}.meta.json"
            with open(meta_path, "w") as meta_f:
                json.dump({
                    "type": "pre_fuzz_capture",
                    "duration": duration,
                    "interface": request.interface,
                    "timestamp": timestamp,
                }, meta_f)
            
            print(f"Pre-fuzz capture saved: {pre_fuzz_log_path}")
        except Exception as e:
            print(f"Pre-fuzz capture failed: {e}")
            # Continue anyway - not critical
    
    # Build Python fuzzing script (more flexible than bash for data generation)
    # Pre-compute data based on mode
    
    # For "logs" mode, extract real samples from mission logs
    log_samples_code = ""
    if mode == "logs" and request.mission_id:
        logs_dir = main.get_mission_logs_dir(request.mission_id)
        id_samples: dict = {}  # canId -> [data_hex, ...]
        
        log_files = []
        if request.log_id:
            target = logs_dir / f"{request.log_id}.log"
            if target.exists():
                log_files = [target]
        else:
            log_files = list(logs_dir.glob("*.log"))
        
        for log_file in log_files:
            if log_file.name.endswith(".meta.json"):
                continue
            try:
                with open(log_file, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        try:
                            parts = line.split()
                            if len(parts) >= 3:
                                frame_parts = parts[2].split("#")
                                if len(frame_parts) == 2:
                                    cid = frame_parts[0].upper()
                                    dhex = frame_parts[1].upper()
                                    if cid not in id_samples:
                                        id_samples[cid] = []
                                    if len(id_samples[cid]) < 200:
                                        id_samples[cid].append(dhex)
                        except:
                            continue
            except:
                continue
        
        # Serialize samples into the script
        log_samples_code = f"LOG_SAMPLES = {json.dumps(id_samples)}\n"
    
    # For "range" mode, build per-byte constraints
    byte_ranges_code = ""
    if mode == "range" and request.byte_ranges:
        byte_ranges_code = f"BYTE_RANGES = {json.dumps(request.byte_ranges)}\n"
    
    # For "target_ids" mode with specific IDs
    target_ids = filtered_targets or []
    
    # Prepare mission log paths for during-fuzz capture and history
    during_fuzz_log_path = None
    history_file_path = "/tmp/aurige_fuzz_history.json"  # Fallback
    
    if request.mission_id:
        from datetime import datetime
        logs_dir = main.get_mission_logs_dir(request.mission_id)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        during_fuzz_log_path = logs_dir / f"during_fuzz_{timestamp}.log"
        history_file_path = str(logs_dir / f"fuzz_history_{timestamp}.json")
    
    script_content = f'''#!/usr/bin/env python3
import subprocess
import time
import random
import sys
import json
import signal
import os

INTERFACE = "{request.interface}"
ID_START = 0x{request.id_start}
ID_END = 0x{request.id_end}
ITERATIONS = {request.iterations}
DELAY_SEC = {request.delay_ms} / 1000.0
DLC = {dlc}
MODE = "{mode}"
DATA_TEMPLATE = "{request.data_template or ''}"
TARGET_IDS = {json.dumps(target_ids)}
MISSION_ID = "{request.mission_id or ''}"
HISTORY_FILE = "{history_file_path}"
DURING_FUZZ_LOG = "{during_fuzz_log_path}" if "{during_fuzz_log_path}" != "None" else None
{log_samples_code}
{byte_ranges_code}

# Initialize history with ALL frames (sent + metadata)
history = {{
    "mission_id": MISSION_ID,
    "started_at": time.time(),
    "stopped_at": None,
    "total_sent": 0,
    "frames_sent": [],
    "during_fuzz_log": DURING_FUZZ_LOG,
}}

# Start candump in background to record all CAN traffic during fuzzing
candump_process = None
candump_log_file = None
if DURING_FUZZ_LOG:
    try:
        candump_log_file = open(DURING_FUZZ_LOG, "w")
        candump_process = subprocess.Popen(
            ["candump", INTERFACE, "-L"],
            stdout=candump_log_file,
            stderr=subprocess.DEVNULL
        )
        print(f"[FUZZ] Recording CAN traffic to {{DURING_FUZZ_LOG}}")
    except Exception as e:
        print(f"[FUZZ] Warning: Could not start candump: {{e}}")

def cleanup():
    """Stop candump on exit"""
    if candump_process:
        candump_process.terminate()
        try:
            candump_process.wait(timeout=2)
        except:
            candump_process.kill()
    if candump_log_file:
        candump_log_file.close()

signal.signal(signal.SIGTERM, lambda s, f: cleanup())
signal.signal(signal.SIGINT, lambda s, f: cleanup())

def generate_data_random():
    return "".join("{{:02X}}".format(random.randint(0, 255)) for _ in range(DLC))

def generate_data_static():
    if DATA_TEMPLATE:
        return DATA_TEMPLATE[:DLC*2].ljust(DLC*2, '0')
    return "00" * DLC

def generate_data_range():
    if not BYTE_RANGES:
        return generate_data_random()
    data = []
    for i in range(DLC):
        matching = [br for br in BYTE_RANGES if br["index"] == i]
        if matching:
            br = matching[0]
            val = random.randint(br["min"], br["max"])
            data.append("{{:02X}}".format(val))
        else:
            data.append("{{:02X}}".format(random.randint(0, 255)))
    return "".join(data)

def generate_data_logs(can_id):
    if not LOG_SAMPLES or can_id not in LOG_SAMPLES:
        return generate_data_random()
    samples = LOG_SAMPLES[can_id]
    return random.choice(samples)

sent = 0
print("Starting fuzzing on {{}}".format(INTERFACE))

try:
    if TARGET_IDS:
        # Targeted mode: cycle through specific IDs
        for i in range(ITERATIONS):
            can_id_hex = TARGET_IDS[i % len(TARGET_IDS)]
            if MODE == "static":
                data = generate_data_static()
            elif MODE == "range":
                data = generate_data_range()
            elif MODE == "logs":
                data = generate_data_logs(can_id_hex)
            else:
                data = generate_data_random()
            
            frame = "{{}}#{{}}".format(can_id_hex, data)
            subprocess.run(["cansend", INTERFACE, frame], capture_output=True)
            sent += 1
            
            history["frames_sent"].append({{
                "index": sent,
                "id": can_id_hex,
                "data": data,
                "timestamp": time.time()
            }})
            
            if sent % 50 == 0:
                sys.stdout.write("\\rSent {{}}/{{}} frames".format(sent, ITERATIONS))
                sys.stdout.flush()
            time.sleep(DELAY_SEC)
    else:
        # Sweep mode: increment through ID range
        id_range = max(1, ID_END - ID_START + 1)
        for i in range(ITERATIONS):
            current_id = ID_START + (i % id_range)
            can_id_hex = "{{:03X}}".format(current_id)
            
            if MODE == "static":
                data = generate_data_static()
            elif MODE == "range":
                data = generate_data_range()
            elif MODE == "logs":
                data = generate_data_logs(can_id_hex)
            else:
                data = generate_data_random()
            
            frame = "{{}}#{{}}".format(can_id_hex, data)
            subprocess.run(["cansend", INTERFACE, frame], capture_output=True)
            sent += 1
            
            history["frames_sent"].append({{
                "index": sent,
                "id": can_id_hex,
                "data": data,
                "timestamp": time.time()
            }})
            
            if sent % 50 == 0:
                sys.stdout.write("\\rSent {{}}/{{}} frames".format(sent, ITERATIONS))
                sys.stdout.flush()
            time.sleep(DELAY_SEC)
finally:
    cleanup()
    
    history["stopped_at"] = time.time()
    history["total_sent"] = sent
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f)
    
    print("\\nFuzzing complete: {{}} frames sent.".format(sent))
    print("History saved to {{}}".format(HISTORY_FILE))
    if DURING_FUZZ_LOG:
        print("CAN traffic recorded to {{}}".format(DURING_FUZZ_LOG))
'''
    
    # Write script to file
    script_path = main.FUZZ_SCRIPT_PATH
    with open(script_path, "w") as f:
        f.write(script_content)
    script_path.chmod(0o755)
    
    # Start process
    main.state.fuzzing_process = main.subprocess.Popen(
        ["python3", str(script_path)],
        stdout=main.subprocess.PIPE,
        stderr=main.subprocess.STDOUT,
        text=True
    )
    
    return {"status": "started", "iterations": request.iterations, "blocked_skipped": blocked_skipped}


@router.post("/api/fuzzing/stop")
async def stop_fuzzing():
    """Stop fuzzing"""
    if not main.state.fuzzing_process or main.state.fuzzing_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No fuzzing running")
    
    # Kill the script and any child cansend processes
    main.state.fuzzing_process.terminate()
    try:
        await asyncio.wait_for(main.state.fuzzing_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        main.state.fuzzing_process.kill()
    
    main.state.fuzzing_process = None
    
    return {"status": "stopped"}


@router.get("/api/fuzzing/status")
async def get_fuzzing_status():
    """Get fuzzing status"""
    is_running = main.state.fuzzing_process is not None and main.state.fuzzing_process.returncode is None
    return {"running": is_running}


@router.post("/api/fuzzing/force-cleanup")
async def force_cleanup_fuzzing():
    """Force cleanup of fuzzing state (for stuck processes)"""
    # Kill any python/candump/cansend processes related to fuzzing
    try:
        main.run_command(["pkill", "-f", "aurige_fuzz.py"], check=False)
        main.run_command(["pkill", "-f", "candump.*during_fuzz"], check=False)
        main.run_command(["pkill", "-f", "cansend"], check=False)
        await asyncio.sleep(0.5)
    except:
        pass
    
    # Reset state
    if main.state.fuzzing_process:
        try:
            main.state.fuzzing_process.kill()
        except:
            pass
    main.state.fuzzing_process = None
    
    return {"status": "cleaned", "message": "Forced cleanup of fuzzing processes"}


@router.post("/api/fuzzing/crash-recovery")
async def attempt_crash_recovery(request: CrashRecoveryRequest):
    """
    Attempt to recover from a crash by sending reset frames (00 00 00...).
    If suspect_ids provided, only reset those. Otherwise, try common crash IDs.
    """
    iface = request.interface
    # Valide l'interface (cohérent avec can/send, fuzzing, etc.)
    if iface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0, can1, or vcan0.")
    suspect_ids = request.suspect_ids or []

    # Common crash-related IDs (airbag, powertrain, BSI status)
    common_crash_ids = ["4C8", "5E8", "3B7", "360", "1A0", "0F6"]
    
    ids_to_reset = suspect_ids if suspect_ids else common_crash_ids
    
    results = []
    for can_id_hex in ids_to_reset:
        # Send zero reset frame
        reset_frame = f"{can_id_hex}#0000000000000000"
        try:
            result = main.run_command(["cansend", iface, reset_frame], check=False)
            results.append({
                "id": can_id_hex,
                "status": "sent" if result.returncode == 0 else "failed",
                "frame": reset_frame,
            })
            # Small delay between resets
            await asyncio.sleep(0.05)
        except Exception as e:
            results.append({
                "id": can_id_hex,
                "status": "error",
                "error": str(e),
            })
    
    return {
        "status": "recovery_attempted",
        "results": results,
        "message": f"Sent {len([r for r in results if r['status'] == 'sent'])} reset frames",
    }


@router.get("/api/fuzzing/history")
async def get_fuzzing_history(mission_id: Optional[str] = None):
    """
    Get the last fuzzing history (frames sent before potential crash).
    If mission_id provided, reads the most recent history file from that mission's logs.
    Otherwise falls back to /tmp/aurige_fuzz_history.json.
    """
    history_file = None
    
    # Try mission-specific history first
    if mission_id:
        try:
            logs_dir = main.get_mission_logs_dir(mission_id)
            history_files = sorted(logs_dir.glob("fuzz_history_*.json"), reverse=True)
            if history_files:
                history_file = history_files[0]  # Most recent
        except:
            pass
    
    # Fallback to global temp file
    if not history_file or not history_file.exists():
        history_file = Path("/tmp/aurige_fuzz_history.json")
    
    if not history_file.exists():
        return {
            "exists": False,
            "frames_sent": [],
            "message": "No fuzzing history found. Run fuzzing with crash detection enabled.",
        }
    
    try:
        with open(history_file, "r") as f:
            data = json.load(f)
        return {
            "exists": True,
            "frames_sent": data.get("frames_sent", data.get("frames", [])),
            "started_at": data.get("started_at"),
            "stopped_at": data.get("stopped_at"),
            "total_sent": data.get("total_sent", 0),
            "mission_id": data.get("mission_id"),
            "during_fuzz_log": data.get("during_fuzz_log"),
        }
    except Exception as e:
        return {
            "exists": True,
            "error": str(e),
            "frames_sent": [],
        }


@router.post("/api/fuzzing/analyze-crash")
async def analyze_crash(mission_id: str, pre_fuzz_log_id: str, during_fuzz_log_id: str):
    """
    Advanced crash analysis: compare pre-fuzz and during-fuzz logs
    to detect anomalies and identify the culprit frame.
    
    Detects:
    - IDs that disappeared (critical systems stopped responding)
    - Sudden value drops (RPM → 0, speed → 0)
    - New error IDs that appeared
    - Timing anomalies
    """
    logs_dir = main.get_mission_logs_dir(mission_id)
    pre_log = logs_dir / f"{pre_fuzz_log_id}.log"
    during_log = logs_dir / f"{during_fuzz_log_id}.log"
    
    if not pre_log.exists() or not during_log.exists():
        raise HTTPException(status_code=404, detail="Log files not found")
    
    # Parse pre-fuzz baseline
    pre_data = {}  # {id: [payloads...]}
    try:
        with open(pre_log, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        cid = frame_parts[0].upper()
                        payload = frame_parts[1].upper()
                        if cid not in pre_data:
                            pre_data[cid] = []
                        pre_data[cid].append(payload)
    except:
        pass
    
    # Parse during-fuzz traffic
    during_data = {}
    during_timeline = []  # [(timestamp, id, payload)]
    try:
        with open(during_log, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    timestamp = float(parts[0].strip("()"))
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        cid = frame_parts[0].upper()
                        payload = frame_parts[1].upper()
                        if cid not in during_data:
                            during_data[cid] = []
                        during_data[cid].append(payload)
                        during_timeline.append((timestamp, cid, payload))
    except:
        pass
    
    # Detect anomalies
    anomalies = []
    
    # 1. IDs that disappeared
    disappeared_ids = set(pre_data.keys()) - set(during_data.keys())
    for cid in disappeared_ids:
        anomalies.append({
            "type": "disappeared",
            "id": cid,
            "severity": "critical",
            "description": f"ID {cid} stopped responding during fuzzing"
        })
    
    # 2. IDs with all-zero payloads (likely crash)
    for cid, payloads in during_data.items():
        if cid in pre_data:
            pre_non_zero = any(p != "0" * len(p) for p in pre_data[cid][:50])
            during_all_zero = all(p == "0" * len(p) for p in payloads[-20:])
            if pre_non_zero and during_all_zero:
                anomalies.append({
                    "type": "zeroed",
                    "id": cid,
                    "severity": "critical",
                    "description": f"ID {cid} data went to all zeros"
                })
    
    # 3. New error IDs (5xx, 7xx ranges)
    new_error_ids = []
    for cid in during_data.keys():
        if cid not in pre_data:
            cid_int = int(cid, 16)
            if (0x500 <= cid_int <= 0x5FF) or (0x700 <= cid_int <= 0x7FF):
                new_error_ids.append(cid)
                anomalies.append({
                    "type": "new_error",
                    "id": cid,
                    "severity": "high",
                    "description": f"New error ID {cid} appeared during fuzzing"
                })
    
    # Load fuzzing history to correlate
    history_file = Path("/tmp/aurige_fuzz_history.json")
    fuzz_frames = []
    if history_file.exists():
        with open(history_file, "r") as f:
            data = json.load(f)
            fuzz_frames = data.get("frames_sent", [])
    
    # Find the culprit: correlate anomaly timing with sent frames
    culprits = []
    if anomalies and fuzz_frames:
        for anomaly in anomalies[:5]:  # Top 5 anomalies
            # Find when the anomaly ID went bad in timeline
            anom_id = anomaly["id"]
            bad_timestamp = None
            for ts, cid, payload in during_timeline:
                if cid == anom_id:
                    if anomaly["type"] == "zeroed" and payload == "0" * len(payload):
                        bad_timestamp = ts
                        break
            
            if bad_timestamp:
                # Find frames sent just before
                suspects = []
                for frame in fuzz_frames:
                    if abs(frame["timestamp"] - bad_timestamp) < 1.0:
                        suspects.append(frame)
                
                if suspects:
                    culprits.append({
                        "anomaly": anomaly,
                        "suspect_frames": suspects[:10],
                        "timing_delta": bad_timestamp - suspects[0]["timestamp"] if suspects else 0
                    })
    
    return {
        "mission_id": mission_id,
        "anomalies": anomalies,
        "disappeared_ids": list(disappeared_ids),
        "new_error_ids": new_error_ids,
        "culprits": culprits,
        "pre_fuzz_ids": sorted(list(pre_data.keys())),
        "during_fuzz_ids": sorted(list(during_data.keys())),
        "message": f"Found {len(anomalies)} anomalies, {len(culprits)} culprits identified"
    }


@router.post("/api/fuzzing/compare-logs")
async def compare_logs_with_fuzzing(mission_id: str, log_id: str):
    """
    Compare a pre-fuzz log with fuzzing history to identify suspect IDs.
    Returns IDs that appeared during fuzzing but not in normal operation.
    """
    # Read pre-fuzz log
    logs_dir = main.get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"
    
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log file not found")
    
    # Extract IDs from pre-fuzz log
    pre_fuzz_ids = set()
    try:
        with open(log_file, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        pre_fuzz_ids.add(frame_parts[0].upper())
    except:
        pass
    
    # Read fuzzing history
    history_file = Path("/tmp/aurige_fuzz_history.json")
    fuzzing_ids = set()
    if history_file.exists():
        try:
            with open(history_file, "r") as f:
                data = json.load(f)
            for frame_info in data.get("frames", []):
                fuzzing_ids.add(frame_info["id"].upper())
        except:
            pass
    
    # Find suspects: in fuzzing but not in pre-fuzz
    suspects = list(fuzzing_ids - pre_fuzz_ids)
    suspects.sort()
    
    return {
        "pre_fuzz_ids": sorted(list(pre_fuzz_ids)),
        "fuzzing_ids": sorted(list(fuzzing_ids)),
        "suspect_ids": suspects,
        "message": f"Found {len(suspects)} suspect IDs not present in normal operation",
    }
