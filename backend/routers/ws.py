"""AURIGE - WebSockets live (candump, cansniffer, signal-finder) + sniffer start/stop.
Extrait de main.py, routes inchangees. L'etat partage (state, sniffer_state) et les
helpers restent dans main.py (acces via main.<nom> a l'execution)."""
import asyncio
import json
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

import main

router = APIRouter()


@router.websocket("/ws/candump")
async def websocket_candump(websocket: WebSocket, interface: str = Query(default="can0")):
    """
    WebSocket endpoint for live CAN traffic streaming.
    
    Starts candump and streams output to connected clients.
    Multiple clients can connect and receive the same stream.
    
    Message format (JSON):
    {
        "timestamp": "1706000000.123456",
        "interface": "can0",
        "canId": "7DF",
        "data": "02 01 0C"
    }
    """
    await websocket.accept()
    main.state.websocket_clients.append(websocket)
    
    try:
        # Start candump if not already running for this interface
        if main.state.candump_process is None or main.state.candump_interface != interface:
            # Stop existing if different interface
            if main.state.candump_process and main.state.candump_process.returncode is None:
                main.state.candump_process.terminate()
                await main.state.candump_process.wait()
            
            # Start new candump
            # -ta: absolute timestamps
            main.state.candump_process = await asyncio.create_subprocess_exec(
                "candump", "-ta", interface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            main.state.candump_interface = interface
        
        # Read and broadcast
        while True:
            if main.state.candump_process.stdout:
                line = await main.state.candump_process.stdout.readline()
                if not line:
                    break
                
                # Parse candump output
                # Format: (1706000000.123456) can0 7DF#02010C
                try:
                    decoded = line.decode().strip()
                    if decoded:
                        parts = decoded.split()
                        if len(parts) >= 3:
                            timestamp = parts[0].strip("()")
                            iface = parts[1]
                            frame_parts = parts[2].split("#")
                            if len(frame_parts) == 2:
                                can_id = frame_parts[0]
                                data = frame_parts[1]
                                # Format data with spaces
                                data_formatted = " ".join(
                                    data[i:i+2] for i in range(0, len(data), 2)
                                )
                                
                                message = json.dumps({
                                    "timestamp": timestamp,
                                    "interface": iface,
                                    "canId": can_id,
                                    "data": data_formatted,
                                })
                                await main.broadcast_to_websockets(message)
                except Exception:
                    pass
            else:
                await asyncio.sleep(0.1)
                
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in main.state.websocket_clients:
            main.state.websocket_clients.remove(websocket)
        
        # Stop candump if no more clients
        if not main.state.websocket_clients and main.state.candump_process:
            main.state.candump_process.terminate()
            main.state.candump_process = None
            main.state.candump_interface = None


@router.post("/api/sniffer/start")
async def start_sniffer(interface: str = "can0"):
    """Start the CAN sniffer (for clients that will connect via WebSocket)"""
    if main.state.candump_process and main.state.candump_process.returncode is None:
        if main.state.candump_interface == interface:
            return {"status": "already_running", "interface": interface}
        # Stop existing
        main.state.candump_process.terminate()
        await main.state.candump_process.wait()
    
    main.state.candump_process = await asyncio.create_subprocess_exec(
        "candump", "-ta", interface,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    main.state.candump_interface = interface
    
    return {"status": "started", "interface": interface}


@router.post("/api/sniffer/stop")
async def stop_sniffer():
    """Stop the CAN sniffer"""
    if not main.state.candump_process or main.state.candump_process.returncode is not None:
        return {"status": "not_running"}
    
    main.state.candump_process.terminate()
    try:
        await asyncio.wait_for(main.state.candump_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        main.state.candump_process.kill()
    
    main.state.candump_process = None
    main.state.candump_interface = None
    
    return {"status": "stopped"}


@router.websocket("/ws/cansniffer")
async def websocket_cansniffer(websocket: WebSocket, interface: str = Query(default="can0")):
    """
    WebSocket endpoint for live CAN traffic view.
    
    Uses candump with timestamp for live monitoring.
    This is for the floating terminal, NOT for recording.
    """
    await websocket.accept()
    main.sniffer_state.clients.append(websocket)
    
    # Each client gets its own candump process for isolation
    process = None
    
    try:
        # Start candump for this client
        # -t a: absolute timestamp, -x: extended info
        process = await asyncio.create_subprocess_exec(
            "candump", "-ta", interface,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        
        # Read and send to this websocket
        while True:
            if process and process.stdout:
                line = await process.stdout.readline()
                if not line:
                    # Process ended
                    break
                
                try:
                    decoded = line.decode().strip()
                    if decoded and not decoded.startswith("interface"):
                        # Parse candump output: (timestamp) interface canid#data
                        # Example: (1234567890.123456)  can0  7DF   [8]  02 01 0C 00 00 00 00 00
                        parts = decoded.split()
                        if len(parts) >= 4:
                            timestamp = parts[0].strip("()")
                            can_id = parts[2]
                            # Find data after [dlc]
                            try:
                                dlc_idx = decoded.index("[")
                                dlc_end = decoded.index("]")
                                dlc = int(decoded[dlc_idx+1:dlc_end])
                                data_part = decoded[dlc_end+1:].strip().replace(" ", "")
                            except (ValueError, IndexError):
                                dlc = 8
                                data_part = "".join(parts[4:]) if len(parts) > 4 else ""
                            
                            msg = json.dumps({
                                "timestamp": float(timestamp) if timestamp else time.time(),
                                "canId": can_id,
                                "data": data_part.upper(),
                                "dlc": dlc,
                            })
                            await websocket.send_text(msg)
                except Exception as e:
                    # Skip malformed lines
                    pass
            else:
                await asyncio.sleep(0.01)
                
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"error": str(e)}))
        except:
            pass
    finally:
        if websocket in main.sniffer_state.clients:
            main.sniffer_state.clients.remove(websocket)
        
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                process.kill()


# =============================================================================
# Health Check
# =============================================================================


@router.websocket("/ws/signal-finder")
async def websocket_signal_finder(websocket: WebSocket, interface: str = Query(default="can0")):
    """
    WebSocket for live OBD/CAN correlation.
    
    Client sends:
      { "action": "start", "pid": "0C", "interface": "can0", "intervalMs": 200 }
      { "action": "stop" }
    
    Server sends:
      { "type": "obd_sample", "timestamp": ..., "value": ..., "unit": "...", "pid": "..." }
      { "type": "can_frame", ... }
      { "type": "correlation_update", "candidates": [...], "sampleCount": N }
      { "type": "status", "message": "..." }
    """
    await websocket.accept()
    
    candump_proc = None
    running = False
    obd_samples = []
    can_buffer = {}  # { can_id: [ { timestamp, bytes } ] }
    
    async def capture_can_traffic(iface: str):
        """Background task to capture CAN frames."""
        nonlocal candump_proc, can_buffer
        try:
            candump_proc = await asyncio.create_subprocess_exec(
                "candump", "-ta", iface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            while running and candump_proc and candump_proc.stdout:
                line = await candump_proc.stdout.readline()
                if not line:
                    break
                decoded = line.decode().strip()
                if not decoded:
                    continue
                parts = decoded.split()
                if len(parts) < 4:
                    continue
                try:
                    timestamp = float(parts[0].strip("()"))
                    can_id = parts[2].upper()
                    if can_id in main.OBD_FILTER_IDS:
                        continue
                    dlc_idx = decoded.index("[")
                    dlc_end = decoded.index("]")
                    data_part = decoded[dlc_end+1:].strip().replace(" ", "").upper()
                    byte_values = []
                    for i in range(0, len(data_part), 2):
                        if i + 2 <= len(data_part):
                            byte_values.append(int(data_part[i:i+2], 16))
                    if can_id not in can_buffer:
                        can_buffer[can_id] = []
                    can_buffer[can_id].append({"timestamp": timestamp, "bytes": byte_values})
                    # Keep only last 500 frames per ID to limit memory
                    if len(can_buffer[can_id]) > 500:
                        can_buffer[can_id] = can_buffer[can_id][-500:]
                    # Send frame to client
                    await websocket.send_text(json.dumps({
                        "type": "can_frame",
                        "timestamp": timestamp,
                        "canId": can_id,
                        "data": data_part,
                    }))
                except Exception:
                    pass
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
    
    can_task = None
    
    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            action = msg.get("action")
            
            if action == "start":
                try:
                    ws_service, pid = main.validate_obd_params(str(msg.get("service", "01")), str(msg.get("pid", "0C")))
                except ValueError as e:
                    await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
                    continue
                if main.obd_service_needs_write(ws_service) and not main.ws_user_may_obd_write(websocket):
                    await websocket.send_text(json.dumps({"type": "error", "message": "Permission refusee (obd_write requis)"}))
                    continue
                iface = msg.get("interface", interface)
                interval_ms = msg.get("intervalMs", 300)
                interval_s = max(interval_ms / 1000.0, 0.15)
                correlation_interval = msg.get("correlationIntervalS", 3)
                
                running = True
                obd_samples.clear()
                can_buffer.clear()
                
                await websocket.send_text(json.dumps({
                    "type": "status",
                    "message": f"Demarrage capture CAN + lecture PID {pid} toutes les {interval_ms}ms",
                }))
                
                # Start CAN capture task
                can_task = asyncio.create_task(capture_can_traffic(iface))
                
                # OBD read loop
                last_correlation_time = time.time()
                
                while running:
                    ts = time.time()
                    decoder = main.OBD_PID_DECODERS.get(pid)
                    data_str = f"02{ws_service}{pid}0000000000"[:16]
                    
                    result = await main.obd_send_with_flow_control(iface, "7DF", data_str, "7E8")
                    
                    if result["success"]:
                        for resp_line in result["responses"]:
                            parsed = main.parse_candump_line(resp_line) if isinstance(resp_line, str) else resp_line
                            if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
                                data_hex = parsed["data"]
                                byte_list = [int(data_hex[i:i+2], 16) for i in range(0, len(data_hex), 2)]
                                if len(byte_list) >= 3 and byte_list[1] == 0x41:
                                    resp_pid = f"{byte_list[2]:02X}"
                                    if resp_pid == pid:
                                        a_val = byte_list[3] if len(byte_list) > 3 else 0
                                        b_val = byte_list[4] if len(byte_list) > 4 else 0
                                        if decoder:
                                            try:
                                                val = round(decoder[2](a_val, b_val), 2)
                                            except Exception:
                                                val = float(a_val)
                                        else:
                                            val = float(a_val)
                                        
                                        sample = {"timestamp": ts, "value": val}
                                        obd_samples.append(sample)
                                        
                                        await websocket.send_text(json.dumps({
                                            "type": "obd_sample",
                                            "timestamp": ts,
                                            "value": val,
                                            "unit": decoder[1] if decoder else "",
                                            "pid": pid,
                                            "name": decoder[0] if decoder else f"PID {pid}",
                                            "sampleCount": len(obd_samples),
                                        }))
                                        break
                    
                    # Periodic correlation
                    if time.time() - last_correlation_time >= correlation_interval and len(obd_samples) >= 5:
                        last_correlation_time = time.time()
                        corr_candidates = main._correlate_obd_with_can(
                            can_buffer, obd_samples,
                            window_ms=100,
                        )
                        await websocket.send_text(json.dumps({
                            "type": "correlation_update",
                            "candidates": corr_candidates[:10],
                            "sampleCount": len(obd_samples),
                            "canIdsCount": len(can_buffer),
                        }))
                    
                    # Check for stop command (non-blocking)
                    try:
                        check_msg = await asyncio.wait_for(websocket.receive_text(), timeout=interval_s)
                        check_data = json.loads(check_msg)
                        if check_data.get("action") == "stop":
                            running = False
                            # Final correlation
                            if len(obd_samples) >= 3:
                                final_candidates = main._correlate_obd_with_can(
                                    can_buffer, obd_samples, window_ms=100,
                                )
                                await websocket.send_text(json.dumps({
                                    "type": "correlation_update",
                                    "candidates": final_candidates[:10],
                                    "sampleCount": len(obd_samples),
                                    "canIdsCount": len(can_buffer),
                                    "final": True,
                                }))
                            await websocket.send_text(json.dumps({
                                "type": "status",
                                "message": f"Arret - {len(obd_samples)} echantillons collectes",
                            }))
                    except asyncio.TimeoutError:
                        pass
            
            elif action == "stop":
                running = False
                await websocket.send_text(json.dumps({
                    "type": "status",
                    "message": "Session arretee",
                }))
    
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        running = False
        if can_task and not can_task.done():
            can_task.cancel()
            try:
                await can_task
            except asyncio.CancelledError:
                pass
        if candump_proc and candump_proc.returncode is None:
            candump_proc.terminate()
            try:
                await asyncio.wait_for(candump_proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                candump_proc.kill()
