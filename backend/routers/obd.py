"""AURIGE - Domaine OBD-II (VIN, DTC, PID, statut, freeze frame, reset, scans).
Extrait de main.py, routes inchangees. Les helpers OBD restent dans main.py
(appeles via main.<nom> a l'execution)."""
import asyncio
import time
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

import main

router = APIRouter()


class OBDRequest(BaseModel):
    interface: str = "can0"
    timeout_ms: int = Field(alias="timeoutMs", default=1000)

    class Config:
        populate_by_name = True


@router.post("/api/obd/vin")
async def read_vin(request: OBDRequest):
    """
    Read Vehicle Identification Number via OBD-II.
    
    Protocol:
    1. Send: 7DF#0209020000000000 (Service 09, PID 02 - VIN request)
    2. Send: 7E0#3000000000000000 (Flow control)
    3. Receive multi-frame response on 7E8
    """
    result = await main.obd_send_with_flow_control(
        request.interface,
        "7DF",
        "0209020000000000",
        "7E8"
    )
    
    if not result["success"]:
        return {
            "status": "error",
            "message": result["error"],
            "data": None,
            "frames": [],
        }
    
    responses = result["responses"]
    decoded_vin = main.decode_vin_from_frames(responses) if responses else ""
    
    return {
        "status": "success" if decoded_vin else ("sent" if responses else "sent"),
        "message": f"VIN: {decoded_vin}" if decoded_vin else ("VIN request sent, waiting for response" if not responses else "VIN response received but could not decode"),
        "data": decoded_vin if decoded_vin else (responses[0] if responses else None),
        "frames": responses,
        "decoded": True if decoded_vin else False,
    }

@router.post("/api/obd/dtc/read")
async def read_dtc(request: OBDRequest):
    """
    Read Diagnostic Trouble Codes (Service 03).

    Protocol:
    1. Send: 7DF#0103000000000000 (Service 03 - Read DTCs)
    2. Send: 7E0#3000000000000000 (Flow control)
    3. Receive response on 7E8
    """
    codes, decoded, responses, err = await main._read_dtcs(request.interface, "03")
    if err:
        return {
            "status": "error",
            "message": err,
            "frames": [],
        }

    return {
        "status": "success" if responses else "sent",
        "message": f"DTC read completed: {len(codes)} code(s) detecte(s)" if codes else ("No DTC found" if responses else "DTC request sent"),
        "data": ",".join(codes) or None,
        "frames": responses,
        "dtcs": codes,
        "dtc_details": decoded,
    }


@router.post("/api/obd/dtc/pending")
async def read_dtc_pending(request: OBDRequest):
    """DTC en attente (Service 07)."""
    codes, details, frames, err = await main._read_dtcs(request.interface, "07")
    if err:
        return {"status": "error", "message": err, "dtcs": [], "dtc_details": [], "frames": []}
    return {
        "status": "success" if frames else "sent",
        "message": f"{len(codes)} DTC en attente" if codes else "Aucun DTC en attente",
        "dtcs": codes,
        "dtc_details": details,
        "frames": frames,
    }


@router.post("/api/obd/dtc/permanent")
async def read_dtc_permanent(request: OBDRequest):
    """DTC permanents (Service 0A)."""
    codes, details, frames, err = await main._read_dtcs(request.interface, "0A")
    if err:
        return {"status": "error", "message": err, "dtcs": [], "dtc_details": [], "frames": []}
    return {
        "status": "success" if frames else "sent",
        "message": f"{len(codes)} DTC permanent(s)" if codes else "Aucun DTC permanent",
        "dtcs": codes,
        "dtc_details": details,
        "frames": frames,
    }

@router.post("/api/obd/pid-read")
async def obd_pid_read(request: Request):
    """Lecture synchrone d'un PID (Mode 01), lecture seule."""
    interface, pid = await main._obd_body(request)
    return await main._read_pid_value(interface, pid, "41", f"0201{pid}0000000000"[:16])


@router.post("/api/obd/status")
async def obd_status(request: OBDRequest):
    """Etat MIL + nombre de DTC (PID 01). Les moniteurs detailles ne sont pas decodes."""
    req = "0201010000000000"
    assert len(req) <= 16
    result = await main.obd_send_with_flow_control(request.interface, "7DF", req, "7E8")
    if not result["success"]:
        return {"status": "error", "message": result.get("error"), "mil_on": False, "dtc_count": 0, "monitors": []}
    ab = main._mode_value_bytes(result["responses"], "41", "01")
    if ab is None:
        return {"status": "no_data", "mil_on": False, "dtc_count": 0, "monitors": [], "raw": result["responses"]}
    return {"status": "success", "mil_on": bool(ab[0] & 0x80), "dtc_count": ab[0] & 0x7F,
            "monitors": [], "raw": result["responses"]}


@router.post("/api/obd/freeze-frame")
async def obd_freeze_frame(request: Request):
    """Lecture d'un PID du freeze frame (Mode 02, frame 00), lecture seule."""
    interface, pid = await main._obd_body(request)
    return await main._read_pid_value(interface, pid, "42", f"0302{pid}000000000000"[:16])


@router.post("/api/obd/dtc/clear")
async def clear_dtc(request: OBDRequest):
    """
    Clear Diagnostic Trouble Codes.
    
    Sends: 7DF#0104000000000000 (Service 04 - Clear DTCs)
    WARNING: This clears all stored DTCs and freeze frame data!
    """
    success, error = main.can_send_frame(request.interface, "7DF", "0104000000000000")
    await asyncio.sleep(0.1)
    
    if not success:
        return {
            "status": "error",
            "message": f"Failed to send frame on {request.interface}: {error}",
        }
    
    return {
        "status": "sent",
        "message": "DTC clear request sent.",
        "warning": "All stored DTCs and freeze frame data may be cleared",
    }


@router.post("/api/obd/reset")
async def reset_ecu(request: OBDRequest):
    """
    Request ECU reset (soft reset).
    
    Sends: 7DF#0211010000000000 (Service 11, subfunction 01 - Hard reset)
    WARNING: This may cause the vehicle to enter a temporary non-operational state!
    """
    success, error = main.can_send_frame(request.interface, "7DF", "0211010000000000")
    
    if not success:
        return {
            "status": "error",
            "message": f"Failed to send frame on {request.interface}: {error}",
        }
    
    return {
        "status": "sent",
        "message": "ECU reset request sent.",
        "warning": "Vehicle may enter temporary non-operational state",
    }


@router.post("/api/obd/scan-pids")
async def scan_all_pids(request: OBDRequest):
    """
    Scan all Service 01 PIDs (0x00 to 0xE0).
    
    This mimics your bash script:
    - Sends requests for PIDs 0-224
    - Captures responses
    - Identifies which PIDs are supported
    """
    supported_pids = []
    
    # Start candump to capture all responses
    log_file = Path(f"/tmp/pid_scan_{int(time.time())}.log")
    
    candump = await asyncio.create_subprocess_exec(
        "candump", "-L", "-ta", f"{request.interface},7DF:7FF,7E8:7E8",
        stdout=open(log_file, "w"),
        stderr=asyncio.subprocess.DEVNULL,
    )
    
    try:
        await asyncio.sleep(0.05)
        
        # Scan PIDs 0x00 to 0xE0 (0-224 decimal)
        for pid in range(0, 225):
            pid_hex = f"{pid:02X}"
            _, _ = main.can_send_frame(request.interface, "7DF", f"0201{pid_hex}0000000000")
            await asyncio.sleep(0.05)  # 50ms delay between requests
        
        # Final wait for responses
        await asyncio.sleep(0.5)
        
    finally:
        candump.terminate()
        try:
            await asyncio.wait_for(candump.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            candump.kill()
    
    # Parse responses to find supported PIDs
    if log_file.exists():
        with open(log_file, "r") as f:
            for line in f:
                if "7e8" in line.lower():
                    # Extract PID from response
                    parts = line.strip().split()
                    if len(parts) >= 4:
                        supported_pids.append(line.strip())
        log_file.unlink()
    
    return {
        "status": "completed",
        "message": f"Scanned {225} PIDs, found {len(supported_pids)} responses",
        "responsesCount": len(supported_pids),
        "responses": supported_pids[:50],  # Limit to first 50 for API response
    }


@router.post("/api/obd/full-scan")
async def full_obd_scan(request: OBDRequest):
    """
    Perform a complete OBD-II scan similar to your bash script:
    1. Request VIN
    2. Scan all Service 01 PIDs
    3. Request DTCs
    
    Results are saved to aurige_obd.log in the mission logs directory.
    """
    results = {
        "vin": None,
        "pids": [],
        "dtcs": [],
        "logFile": None,
    }
    
    # Use /tmp for the scan log
    log_path = Path(f"/tmp/aurige_obd_{int(time.time())}.log")
    
    with open(log_path, "w") as f:
        f.write("########## VIN DU VEHICULE ##########\n")
        
        # 1. Request VIN
        vin_result = await main.obd_send_with_flow_control(
            request.interface, "7DF", "0209020000000000", "7E8"
        )
        if vin_result["success"]:
            for line in vin_result["responses"]:
                f.write(line + "\n")
            decoded_vin = main.decode_vin_from_frames(vin_result["responses"])
            results["vin"] = [decoded_vin] if decoded_vin else vin_result["responses"]
            results["vin_raw"] = vin_result["responses"]
        else:
            f.write(f"Error: {vin_result['error']}\n")
            results["vin"] = []
        
        f.write("\n########## SCAN DES PIDS ##########\n")
        
        # 2. Scan PIDs (shortened for API response time)
        # Scan key PIDs only: 0x00, 0x01, 0x05, 0x0C, 0x0D, 0x0F, 0x11
        key_pids = [0x00, 0x01, 0x05, 0x0C, 0x0D, 0x0F, 0x11, 0x1F, 0x2F]
        
        candump = await asyncio.create_subprocess_exec(
            "candump", "-L", "-ta", f"{request.interface},7DF:7FF,7E8:7E8",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        
        await asyncio.sleep(0.05)
        
        for pid in key_pids:
            _, _ = main.can_send_frame(request.interface, "7DF", f"0201{pid:02X}0000000000")
            await asyncio.sleep(0.1)
        
        await asyncio.sleep(0.5)
        candump.terminate()
        
        f.write("\n########## DTCs DU VEHICULE ##########\n")
        
        # 3. Request DTCs
        dtc_result = await main.obd_send_with_flow_control(
            request.interface, "7DF", "0103000000000000", "7E8"
        )
        if dtc_result["success"]:
            for line in dtc_result["responses"]:
                f.write(line + "\n")
            decoded_dtcs = [d["code"] for d in main.decode_dtcs_from_frames(dtc_result["responses"])]
            results["dtcs"] = decoded_dtcs if decoded_dtcs else dtc_result["responses"]
            results["dtcs_raw"] = dtc_result["responses"]
        else:
            f.write(f"Error: {dtc_result['error']}\n")
            results["dtcs"] = []
    
    results["logFile"] = str(log_path)
    
    # Also save as JSON report for later retrieval
    report_path = Path("/tmp/aurige_last_obd_report.json")
    import json as json_mod
    report_data = {
        "timestamp": time.time(),
        "interface": request.interface,
        "vin": results["vin"],
        "vin_raw": results.get("vin_raw", []),
        "pids": results["pids"],
        "dtcs": results["dtcs"],
        "dtcs_raw": results.get("dtcs_raw", []),
        "logFile": str(log_path),
    }
    with open(report_path, "w") as rf:
        json_mod.dump(report_data, rf, indent=2)
    
    return {
        "status": "completed",
        "message": "Full OBD scan completed",
        "results": results,
    }


@router.get("/api/obd/last-report")
async def get_last_obd_report():
    """Get the last OBD-II scan report if available"""
    import json as json_mod
    report_path = Path("/tmp/aurige_last_obd_report.json")
    if not report_path.exists():
        return {"status": "not_found", "message": "Aucun rapport OBD disponible"}
    try:
        with open(report_path, "r") as f:
            report = json_mod.load(f)
        return {"status": "success", "report": report}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/api/obd/pid")
async def read_obd_pid(
    request: Request,
    interface: str = "can0",
    service: str = "01",  # Service 01 = Current Data
    pid: str = "0C",  # PID 0C = Engine RPM
):
    """
    Read a specific OBD-II PID.
    
    Common PIDs:
    - 01 0C: Engine RPM
    - 01 0D: Vehicle Speed
    - 01 05: Engine Coolant Temp
    - 01 0F: Intake Air Temp
    - 01 2F: Fuel Level
    """
    service, pid = main.guard_obd_http(request, service, pid)
    # Format: Length + Service + PID + padding
    data = f"02{service}{pid}0000000000"[:16]
    _, _ = main.can_send_frame(interface, "7DF", data)
    
    return {
        "status": "sent",
        "service": service,
        "pid": pid,
        "message": f"OBD-II request sent for service {service}, PID {pid}",
    }
