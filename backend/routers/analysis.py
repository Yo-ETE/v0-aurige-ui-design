"""AURIGE - Analyse CAN (family-diff, correlation OBD, heatmap, detection de signaux,
dependances inter-ID, validation causale) + signal-finder HTTP.
Extrait de main.py, routes inchangees. Modeles Pydantic et helpers restent dans
main.py (router inclus en fin de main.py). Helpers appeles via main.<nom> a l'execution.
Le WebSocket /ws/signal-finder reste dans main.py."""
import asyncio
import re
import time
from pathlib import Path
from bisect import bisect_left
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import main
from main import (
    AnalyzeFamilyRequest,
    AutoDetectRequest,
    ByteDiff,
    CausalityRequest,
    DependencyRequest,
    FamilyAnalysisResponse,
    FrameDiff,
    HeatmapRequest,
    SignalFinderCorrelationRequest,
)

router = APIRouter()


@router.post("/api/analysis/family-diff")
async def analyze_family_diff(request: AnalyzeFamilyRequest) -> FamilyAnalysisResponse:
    """
    Analyse les differences AVANT/ACK/STATUS pour une famille d'IDs.
    Compare les payloads dans trois fenetres temporelles autour de t0.
    """
    import traceback
    try:
        print(f"[DEBUG] family-diff request: mission={request.mission_id}, log={request.log_id}, t0={request.t0_timestamp}")
        print(f"[DEBUG] family_ids: {request.family_ids}")
        print(f"[DEBUG] offsets: before={request.before_offset_ms}, ack={request.ack_offset_ms}, status={request.status_offset_ms}")
        
        mission_dir = Path(main.MISSIONS_DIR) / request.mission_id / "logs"
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {mission_dir}")
        
        # Find log file
        log_file = None
        for f in mission_dir.glob("*.log"):
            if f.stem == request.log_id or f.name == request.log_id:
                log_file = f
                break
        
        if not log_file:
            available_logs = [f.name for f in mission_dir.glob("*.log")]
            raise HTTPException(status_code=404, detail=f"Log non trouve: {request.log_id}. Disponibles: {available_logs}")
        
        print(f"[DEBUG] Found log file: {log_file}")
        
        # Calculate absolute timestamps from t0 and offsets
        t0 = request.t0_timestamp
        before_start = t0 + request.before_offset_ms[0] / 1000
        before_end = t0 + request.before_offset_ms[1] / 1000
        ack_start = t0 + request.ack_offset_ms[0] / 1000
        ack_end = t0 + request.ack_offset_ms[1] / 1000
        status_start = t0 + request.status_offset_ms[0] / 1000
        status_end = t0 + request.status_offset_ms[1] / 1000
        
        # Parse log and extract frames in 3 windows
        frames_before: dict[str, list[str]] = {id: [] for id in request.family_ids}
        frames_ack: dict[str, list[str]] = {id: [] for id in request.family_ids}
        frames_status: dict[str, list[str]] = {id: [] for id in request.family_ids}
        
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
                if not match:
                    continue
                
                ts = float(match.group(1))
                can_id = match.group(2).upper()
                data = match.group(3).upper()
                
                if can_id not in request.family_ids:
                    continue
                
                # Classify into 3 windows
                if before_start <= ts <= before_end:
                    frames_before[can_id].append(data)
                if ack_start <= ts <= ack_end:
                    frames_ack[can_id].append(data)
                if status_start <= ts <= status_end:
                    frames_status[can_id].append(data)
        
        # Helper to get representative payload
        def get_representative(data_list: list[str]) -> str:
            if not data_list:
                return ""
            from collections import Counter
            return Counter(data_list).most_common(1)[0][0]
        
        # Analyze differences for each ID
        frames_analysis = []
        status_count = 0
        ack_count = 0
        info_count = 0
        unchanged_count = 0
        
        for can_id in request.family_ids:
            before_data = frames_before.get(can_id, [])
            ack_data = frames_ack.get(can_id, [])
            status_data = frames_status.get(can_id, [])
            
            sample_before = get_representative(before_data) or ""
            sample_ack = get_representative(ack_data) or ""
            sample_status = get_representative(status_data) or ""
            
            # Keep original payload lengths - no padding to 16
            # Only pad to match lengths between samples for comparison
            max_len = max(len(sample_before), len(sample_ack), len(sample_status)) or 16
            
            # Calculate byte-level diff (BEFORE vs STATUS for persistence)
            bytes_diff = []
            compare_before = sample_before.ljust(max_len, "0") if sample_before else "0" * max_len
            compare_after = (sample_status or sample_ack or "").ljust(max_len, "0") if (sample_status or sample_ack) else "0" * max_len
            
            for i in range(0, min(len(compare_before), len(compare_after)), 2):
                byte_before = compare_before[i:i+2] if i+2 <= len(compare_before) else "00"
                byte_after = compare_after[i:i+2] if i+2 <= len(compare_after) else "00"
                
                if byte_before != byte_after:
                    try:
                        val_before = int(byte_before, 16)
                        val_after = int(byte_after, 16)
                        xor = val_before ^ val_after
                        changed_bits = [b for b in range(8) if xor & (1 << b)]
                    except ValueError:
                        changed_bits = []
                    
                    bytes_diff.append(ByteDiff(
                        byte_index=i // 2,
                        value_before=byte_before,
                        value_after=byte_after,
                        changed_bits=changed_bits
                    ))
            
            # Classification based on 3-window persistence
            has_before = len(before_data) > 0
            has_ack = len(ack_data) > 0
            has_status = len(status_data) > 0
            
            # Check if ACK differs from BEFORE
            ack_differs = sample_ack and sample_before and sample_ack != sample_before
            # Check if STATUS differs from BEFORE
            status_differs = sample_status and sample_before and sample_status != sample_before
            # Check if ACK same as STATUS (persistent change)
            ack_persists = sample_ack and sample_status and sample_ack == sample_status
            
            # Classification logic based on persistence
            confidence = 0.0
            persistence = "none"
            
            if status_differs and has_status:
                # STATUS: payload different in STATUS window = persistent state change
                classification = "status"
                status_count += 1
                persistence = "persistent"
                confidence = 90.0 if (has_before and len(status_data) > 3) else 70.0
            elif ack_differs and has_ack and not status_differs:
                # ACK: changes in ACK window but not persistent in STATUS
                classification = "ack"
                ack_count += 1
                persistence = "transient"
                confidence = 80.0 if len(ack_data) > 1 else 50.0
            elif not has_before and (has_ack or has_status):
                # New frame appearing after t0
                if has_status:
                    classification = "status"
                    status_count += 1
                    persistence = "persistent"
                    confidence = 60.0
                else:
                    classification = "ack"
                    ack_count += 1
                    persistence = "transient"
                    confidence = 50.0
            elif len(bytes_diff) > 0:
                # Some change detected
                classification = "info"
                info_count += 1
                confidence = 40.0
            else:
                classification = "unchanged"
                unchanged_count += 1
                confidence = 100.0
            
            frames_analysis.append(FrameDiff(
                can_id=can_id,
                count_before=len(before_data),
                count_ack=len(ack_data),
                count_status=len(status_data),
                bytes_diff=bytes_diff,
                classification=classification,
                confidence=confidence,
                sample_before=sample_before or "N/A",
                sample_ack=sample_ack or "N/A",
                sample_status=sample_status or "N/A",
                persistence=persistence
            ))
        
        # Sort by: classification priority, then confidence desc, then number of changes
        priority = {"status": 0, "ack": 1, "info": 2, "unchanged": 3}
        frames_analysis.sort(key=lambda x: (priority.get(x.classification, 4), -x.confidence, -len(x.bytes_diff)))
        
        return FamilyAnalysisResponse(
            family_name=f"ECU 0x{request.family_ids[0]}-0x{request.family_ids[-1]}" if len(request.family_ids) > 1 else f"ID 0x{request.family_ids[0]}",
            frame_ids=request.family_ids,
            frames_analysis=frames_analysis,
            summary={
                "total": len(request.family_ids),
                "status": status_count,
                "ack": ack_count,
                "info": info_count,
                "unchanged": unchanged_count
            },
            t0_timestamp=t0
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] family-diff failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erreur interne: {str(e)}")


@router.post("/api/analysis/correlate-obd")
async def correlate_obd_endpoint(request: SignalFinderCorrelationRequest):
    """
    Offline correlation: match OBD-II samples with CAN log data.
    Accepts OBD samples + either a mission log path or a raw log path.
    Returns top correlation candidates with visualization data.
    """
    start_time = time.time()
    
    log_path = None
    
    # Find the log file
    if request.log_path:
        log_path = Path(request.log_path)
    elif request.mission_id:
        mission_dir = main.MISSIONS_DIR / request.mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {request.mission_id}")
        logs_dir = mission_dir / "logs"
        if logs_dir.exists():
            log_files = sorted(logs_dir.glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
            if log_files:
                log_path = log_files[0]
    
    if not log_path or not log_path.exists():
        raise HTTPException(status_code=400, detail="Aucun fichier log CAN trouve. Fournissez log_path ou mission_id avec des logs.")
    
    obd_samples = [{"timestamp": s.timestamp, "value": s.value} for s in request.obd_samples]
    
    if len(obd_samples) < 3:
        raise HTTPException(status_code=400, detail="Minimum 3 echantillons OBD requis pour la correlation.")
    
    # Parse the CAN log
    can_data = main._parse_log_for_correlation(str(log_path))
    
    total_ids = len(can_data)
    total_frames = sum(len(frames) for frames in can_data.values())
    
    target_ids = request.target_ids if request.target_ids else None
    
    candidates = main._correlate_obd_with_can(
        can_data,
        obd_samples,
        window_ms=request.window_ms,
        target_ids=target_ids,
    )
    
    elapsed = round((time.time() - start_time) * 1000, 1)
    
    return {
        "status": "success",
        "candidates": candidates,
        "total_ids_analyzed": total_ids,
        "total_frames_processed": total_frames,
        "elapsed_ms": elapsed,
        "log_file": str(log_path),
        "obd_sample_count": len(obd_samples),
    }


@router.post("/api/signal-finder/extract-obd-from-log")
async def extract_obd_from_log(
    mission_id: Optional[str] = None,
    log_path: Optional[str] = None,
    pid: str = "0C",
):
    """
    Parse a CAN log file and extract OBD-II response samples for a given PID.
    Returns decoded timestamp + value pairs that can be used directly for correlation.
    """
    resolved_path = None

    if log_path:
        resolved_path = Path(log_path)
    elif mission_id:
        mission_dir = main.MISSIONS_DIR / mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {mission_id}")
        logs_dir = mission_dir / "logs"
        if logs_dir.exists():
            log_files = sorted(logs_dir.glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
            if log_files:
                resolved_path = log_files[0]

    if not resolved_path or not resolved_path.exists():
        raise HTTPException(status_code=400, detail="Aucun fichier log CAN trouve.")

    samples = main._extract_obd_samples_from_log(str(resolved_path), pid)

    decoder = main.OBD_PID_DECODERS.get(pid.upper())

    return {
        "status": "success",
        "pid": pid.upper(),
        "name": decoder[0] if decoder else f"PID {pid.upper()}",
        "unit": decoder[1] if decoder else "",
        "samples": samples,
        "count": len(samples),
        "log_file": str(resolved_path),
    }


@router.post("/api/signal-finder/read-pid")
async def signal_finder_read_pid(
    request: Request,
    interface: str = "can0",
    pid: str = "0C",
    service: str = "01",
):
    """
    Read a specific OBD-II PID and return the decoded value.
    Used by Signal Finder to collect OBD samples in live mode.
    """
    service, pid = main.guard_obd_http(request, service, pid)
    ts = time.time()
    
    pid_upper = pid.upper()
    decoder = main.OBD_PID_DECODERS.get(pid_upper)
    
    data = f"02{service}{pid_upper}0000000000"[:16]
    
    result = await main.obd_send_with_flow_control(
        interface, "7DF", data, "7E8"
    )
    
    if not result["success"]:
        return {
            "success": False,
            "timestamp": ts,
            "pid": pid_upper,
            "raw_hex": "",
            "decoded_value": None,
            "unit": decoder[1] if decoder else "",
            "name": decoder[0] if decoder else f"PID {pid_upper}",
            "error": result["error"],
        }
    
    # Parse response to extract data bytes
    decoded_value = None
    raw_hex = ""
    for resp_line in result["responses"]:
        parsed = main.parse_candump_line(resp_line) if isinstance(resp_line, str) else resp_line
        if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
            data_hex = parsed["data"]
            raw_hex = data_hex
            byte_list = [int(data_hex[i:i+2], 16) for i in range(0, len(data_hex), 2)]
            
            # Check response: byte[1] should be 0x41 (response to service 01)
            # Format: [length, 0x41, PID, A, B, ...]
            if len(byte_list) >= 3 and byte_list[1] == 0x41:
                resp_pid = f"{byte_list[2]:02X}"
                if resp_pid == pid_upper:
                    a_val = byte_list[3] if len(byte_list) > 3 else 0
                    b_val = byte_list[4] if len(byte_list) > 4 else 0
                    if decoder:
                        try:
                            decoded_value = round(decoder[2](a_val, b_val), 2)
                        except Exception:
                            decoded_value = a_val
                    else:
                        decoded_value = a_val
                    break
    
    return {
        "success": decoded_value is not None,
        "timestamp": ts,
        "pid": pid_upper,
        "raw_hex": raw_hex,
        "decoded_value": decoded_value,
        "unit": decoder[1] if decoder else "",
        "name": decoder[0] if decoder else f"PID {pid_upper}",
        "error": None if decoded_value is not None else "Pas de reponse OBD valide",
        "frames": result["responses"],
    }


@router.post("/api/analysis/byte-heatmap")
async def byte_heatmap_endpoint(request: HeatmapRequest):
    """
    Analyse un log CAN et retourne une matrice de variabilite par (CAN_ID, byte).
    Pour chaque byte: change_rate, entropie de Shannon, min/max, nb unique.
    """
    start_time = time.time()
    log_path = main._resolve_log_path(request.mission_id, request.log_path, request.log_id)

    # Parse log
    can_data = main._parse_log_for_correlation(str(log_path))

    total_frames = sum(len(frames) for frames in can_data.values())

    ids_result = []
    for can_id in sorted(can_data.keys()):
        frames = can_data[can_id]
        if not frames:
            continue
        # Limit frames if needed
        if len(frames) > request.sample_limit:
            frames = frames[:request.sample_limit]

        dlc = max(len(f["bytes"]) for f in frames)
        frame_count = len(frames)

        # frequency estimation
        if frame_count >= 2:
            duration = frames[-1]["timestamp"] - frames[0]["timestamp"]
            freq_hz = round(frame_count / duration, 1) if duration > 0 else 0.0
        else:
            freq_hz = 0.0

        # Series par octet pour la detection compteur/checksum (classification cardinalite)
        byte_series = {
            bi: [f["bytes"][bi] for f in frames if bi < len(f["bytes"])]
            for bi in range(dlc)
        }
        counters = main._detect_counter_bytes(byte_series, dlc, 0.75)
        checksums = main._detect_checksum_bytes(byte_series, dlc, 0.70)

        bytes_info = []
        for bi in range(dlc):
            byte_vals = byte_series[bi]
            if not byte_vals:
                bytes_info.append({
                    "index": bi, "change_rate": 0, "entropy": 0,
                    "min": 0, "max": 0, "unique_count": 0, "is_constant": True,
                    "klass": "constant", "distinct_values": [], "score": 0,
                })
                continue
            cr = main._change_rate(byte_vals)
            ent = main._shannon_entropy(byte_vals)
            k, dv, sc = main._classify_action_byte(
                byte_vals, frame_count, bi in counters, bi in checksums
            )
            bytes_info.append({
                "klass": k,
                "distinct_values": dv,
                "score": sc,
                "index": bi,
                "change_rate": cr,
                "entropy": round(ent, 4),
                "min": min(byte_vals),
                "max": max(byte_vals),
                "unique_count": len(set(byte_vals)),
                "is_constant": cr == 0,
            })

        ids_result.append({
            "can_id": can_id,
            "frame_count": frame_count,
            "dlc": dlc,
            "frequency_hz": freq_hz,
            "bytes": bytes_info,
        })

    # Sort by frequency descending
    ids_result.sort(key=lambda x: x["frequency_hz"], reverse=True)

    elapsed = round((time.time() - start_time) * 1000, 1)
    return {
        "status": "success",
        "ids": ids_result,
        "total_frames": total_frames,
        "total_ids": len(ids_result),
        "elapsed_ms": elapsed,
    }


@router.post("/api/analysis/auto-detect-signals")
async def auto_detect_signals_endpoint(request: AutoDetectRequest):
    """
    Detecte automatiquement les frontieres de signaux dans les messages CAN
    en utilisant l'entropie, le change_rate, et la correlation temporelle entre bytes adjacents.
    """
    start_time = time.time()
    log_path = main._resolve_log_path(request.mission_id, request.log_path, request.log_id)

    can_data = main._parse_log_for_correlation(str(log_path))

    ids_to_analyze = request.target_ids if request.target_ids else sorted(can_data.keys())

    detected_signals = []
    all_excluded_bytes = {}  # { can_id: { byte_index: { type, ... } } }

    for can_id in ids_to_analyze:
        if can_id not in can_data:
            continue
        frames = can_data[can_id]
        if len(frames) < 10:
            continue

        dlc = max(len(f["bytes"]) for f in frames)

        # --- Step 1: per-byte metrics ---
        byte_series = {}
        for bi in range(dlc):
            byte_series[bi] = [f["bytes"][bi] for f in frames if bi < len(f["bytes"])]

        byte_metrics = {}
        for bi in range(dlc):
            vals = byte_series[bi]
            if not vals:
                continue
            ent = main._shannon_entropy(vals)
            cr = main._change_rate(vals)
            byte_metrics[bi] = {"entropy": ent, "change_rate": cr, "values": vals}

        # --- Step 1.5: Pre-scan for counters and checksums ---
        excluded_set = set()
        id_excluded = {}
        if request.exclude_counters:
            counters = main._detect_counter_bytes(byte_series, dlc, request.counter_threshold)
            for bi, info in counters.items():
                excluded_set.add(bi)
                id_excluded[bi] = info
        if request.exclude_checksums:
            checksums = main._detect_checksum_bytes(byte_series, dlc, request.checksum_threshold)
            for bi, info in checksums.items():
                excluded_set.add(bi)
                id_excluded[bi] = info
        if id_excluded:
            all_excluded_bytes[can_id] = id_excluded

        # --- Step 2: identify active bytes (above entropy threshold), excluding counters/checksums ---
        active_bytes = []
        for bi in range(dlc):
            if bi in excluded_set:
                continue
            if bi in byte_metrics and byte_metrics[bi]["entropy"] >= request.min_entropy:
                active_bytes.append(bi)

        if not active_bytes:
            continue

        # --- Step 3: compute temporal correlation between adjacent active bytes ---
        # Two bytes belong to the same multi-byte signal if they change at the same time
        adjacency_corr = {}
        for i in range(len(active_bytes) - 1):
            bi = active_bytes[i]
            bj = active_bytes[i + 1]
            if bj != bi + 1:
                # Non-adjacent: skip
                continue
            vals_i = byte_metrics[bi]["values"]
            vals_j = byte_metrics[bj]["values"]
            n = min(len(vals_i), len(vals_j))
            if n < 5:
                continue
            # Compute change correlation: do they change at the same frames?
            changes_i = [1 if vals_i[k] != vals_i[k - 1] else 0 for k in range(1, n)]
            changes_j = [1 if vals_j[k] != vals_j[k - 1] else 0 for k in range(1, n)]
            # Jaccard similarity of change positions
            both = sum(1 for a, b in zip(changes_i, changes_j) if a == 1 and b == 1)
            either = sum(1 for a, b in zip(changes_i, changes_j) if a == 1 or b == 1)
            corr = both / either if either > 0 else 0.0
            adjacency_corr[(bi, bj)] = corr

        # --- Step 4: Cluster adjacent correlated bytes into signal groups ---
        groups = []
        visited = set()
        for bi in active_bytes:
            if bi in visited:
                continue
            group = [bi]
            visited.add(bi)
            current = bi
            while True:
                nxt = current + 1
                if nxt in visited or nxt not in active_bytes:
                    break
                corr = adjacency_corr.get((current, nxt), 0)
                if corr >= request.correlation_threshold:
                    group.append(nxt)
                    visited.add(nxt)
                    current = nxt
                else:
                    break
            groups.append(group)

        # --- Step 5: For each signal group, determine properties ---
        for group in groups:
            start_byte = group[0]
            length_bytes = len(group)
            bit_length = length_bytes * 8
            start_bit = start_byte * 8

            # Gather all values from the group
            all_vals_be = []
            all_vals_le = []
            for frame in frames:
                b = frame["bytes"]
                if start_byte + length_bytes > len(b):
                    continue
                # Big Endian
                val_be = 0
                for gi, gbi in enumerate(group):
                    val_be = (val_be << 8) | b[gbi]
                all_vals_be.append(val_be)
                # Little Endian
                val_le = 0
                for gi, gbi in enumerate(reversed(group)):
                    val_le = (val_le << 8) | b[gbi]
                all_vals_le.append(val_le)

            if not all_vals_be:
                continue

            # Determine endianness: prefer the one with smoother transitions
            def _smoothness(vals):
                if len(vals) < 2:
                    return 0.0
                diffs = [abs(vals[i] - vals[i - 1]) for i in range(1, len(vals))]
                return sum(diffs) / len(diffs) if diffs else 0.0

            smooth_be = _smoothness(all_vals_be)
            smooth_le = _smoothness(all_vals_le)
            # Lower avg diff = smoother = more likely correct
            if smooth_le < smooth_be and length_bytes > 1:
                byte_order = "little_endian"
                all_vals = all_vals_le
            else:
                byte_order = "big_endian"
                all_vals = all_vals_be

            # Signed detection: if values span the upper half of range, might be signed
            max_unsigned = (1 << bit_length) - 1
            threshold_sign = max_unsigned * 0.6
            is_signed = any(v > threshold_sign for v in all_vals) and min(all_vals) < max_unsigned * 0.3

            val_min = min(all_vals)
            val_max = max(all_vals)

            # Confidence based on entropy + change_rate of constituent bytes
            avg_entropy = sum(byte_metrics[bi]["entropy"] for bi in group) / len(group)
            avg_cr = sum(byte_metrics[bi]["change_rate"] for bi in group) / len(group)
            confidence = round(0.5 * min(avg_entropy / 8.0, 1.0) + 0.5 * avg_cr, 4)

            # Sample values (evenly spaced, max 8)
            step = max(1, len(all_vals) // 8)
            sample_vals = [all_vals[i] for i in range(0, len(all_vals), step)][:8]

            name = f"Sig_{can_id}_B{start_byte}_{bit_length}b"

            detected_signals.append({
                "can_id": can_id,
                "name": name,
                "start_byte": start_byte,
                "length_bytes": length_bytes,
                "start_bit": start_bit,
                "bit_length": bit_length,
                "byte_order": byte_order,
                "is_signed": is_signed,
                "entropy": round(avg_entropy, 4),
                "change_rate": round(avg_cr, 4),
                "value_range": [val_min, val_max],
                "sample_values": sample_vals,
                "confidence": confidence,
            })

    # Sort by confidence descending
    detected_signals.sort(key=lambda s: s["confidence"], reverse=True)

    elapsed = round((time.time() - start_time) * 1000, 1)
    return {
        "status": "success",
        "detected_signals": detected_signals,
        "excluded_bytes": all_excluded_bytes,
        "total_ids_analyzed": len(ids_to_analyze),
        "total_signals_found": len(detected_signals),
        "elapsed_ms": elapsed,
    }


@router.post("/api/analysis/inter-id-dependencies")
async def inter_id_dependencies_endpoint(request: DependencyRequest):
    """
    Detect inter-ID dependencies: when an ID's payload changes (event),
    which other IDs change within a short window after?
    Returns edges sorted by score (conditional probability lift).
    """
    start_time = time.time()
    log_path = main._resolve_log_path(request.mission_id, request.log_path, request.log_id)

    window_s = request.window_ms / 1000.0

    # Parse log into ordered frames
    all_frames = []  # [ (timestamp, can_id, payload_hex) ]
    with open(str(log_path), "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
            if not match:
                continue
            ts = float(match.group(1))
            can_id = match.group(2).upper()
            payload = match.group(3).upper()
            if can_id in main.OBD_FILTER_IDS:
                continue
            all_frames.append((ts, can_id, payload))

    if len(all_frames) < 20:
        raise HTTPException(status_code=400, detail="Pas assez de trames pour analyser les dependances.")

    all_frames.sort(key=lambda f: f[0])
    total_frames = len(all_frames)
    duration = all_frames[-1][0] - all_frames[0][0] if total_frames >= 2 else 0

    # Build per-ID event list (payload changes)
    last_payload = {}  # can_id -> last payload hex
    events = {}  # can_id -> [timestamp of payload change]

    for ts, can_id, payload in all_frames:
        prev = last_payload.get(can_id)
        last_payload[can_id] = payload
        if prev is not None and payload != prev:
            if can_id not in events:
                events[can_id] = []
            events[can_id].append(ts)

    # Filter: only IDs with enough events
    active_ids = {cid for cid, evts in events.items() if len(evts) >= 3}

    if len(active_ids) < 2:
        return {
            "status": "success",
            "edges": [],
            "nodes": [],
            "total_frames": total_frames,
            "duration_s": round(duration, 2),
            "elapsed_ms": round((time.time() - start_time) * 1000, 1),
        }

    # For each pair (source, target), count how many source events
    # have a target event within window_ms after.
    edges = []

    source_ids = sorted(active_ids, key=lambda c: len(events[c]), reverse=True)

    for src in source_ids:
        src_events = events[src]
        src_count = len(src_events)

        for tgt in active_ids:
            if tgt == src:
                continue
            tgt_events = events[tgt]
            tgt_count = len(tgt_events)

            # Count co-occurrences: src event followed by tgt event within window
            co = 0
            ti = 0  # pointer into tgt_events
            for se in src_events:
                # Advance tgt pointer to first event >= se
                while ti < len(tgt_events) and tgt_events[ti] < se:
                    ti += 1
                # Check if any tgt event in [se, se + window]
                tj = ti
                while tj < len(tgt_events) and tgt_events[tj] <= se + window_s:
                    co += 1
                    break  # only count once per source event
                    tj += 1

            if co < 2:
                continue

            # Conditional probability: P(tgt reacts | src event)
            p_react = co / src_count
            # Background rate: how often does tgt change per second?
            bg_rate = tgt_count / duration if duration > 0 else 0
            # Expected co-occurrences by chance
            p_chance = min(bg_rate * window_s, 1.0)

            # Score = lift (how much more likely than chance)
            if p_chance > 0:
                lift = p_react / p_chance
            else:
                lift = p_react * 100

            score = round(min(p_react * min(lift, 10) / 10, 1.0), 4)

            if score < request.min_score:
                continue

            edges.append({
                "source": src,
                "target": tgt,
                "co_occurrences": co,
                "source_events": src_count,
                "target_events": tgt_count,
                "p_react": round(p_react, 4),
                "lift": round(lift, 2),
                "score": score,
            })

    # Sort by score descending, limit
    edges.sort(key=lambda e: e["score"], reverse=True)
    edges = edges[:request.top_n]

    # Build node list with metadata
    node_ids = set()
    for e in edges:
        node_ids.add(e["source"])
        node_ids.add(e["target"])

    nodes = []
    for cid in sorted(node_ids):
        evt_count = len(events.get(cid, []))
        out_edges = sum(1 for e in edges if e["source"] == cid)
        in_edges = sum(1 for e in edges if e["target"] == cid)
        nodes.append({
            "id": cid,
            "event_count": evt_count,
            "out_degree": out_edges,
            "in_degree": in_edges,
            "role": "source" if out_edges > in_edges else ("target" if in_edges > out_edges else "both"),
        })

    elapsed = round((time.time() - start_time) * 1000, 1)
    return {
        "status": "success",
        "edges": edges,
        "nodes": nodes,
        "total_frames": total_frames,
        "active_ids": len(active_ids),
        "duration_s": round(duration, 2),
        "elapsed_ms": elapsed,
    }


@router.post("/api/analysis/validate-causality")
async def validate_causality_endpoint(request: CausalityRequest):
    """
    Experimentally validate a causal dependency A -> B.
    For each iteration:
      1. Start monitoring candump for target_id changes
      2. Inject source_id frame (last known payload from log)
      3. Wait window_ms for target_id to react
      4. Record success/failure + lag
    """
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Interface invalide")
    if request.repeat < 1 or request.repeat > 20:
        raise HTTPException(status_code=400, detail="repeat doit etre entre 1 et 20")

    src = request.source_id.upper().replace("0X", "")
    tgt = request.target_id.upper().replace("0X", "")

    # AUD-06 : on n'injecte pas depuis un ID critique
    if main.is_id_blocked(src):
        raise HTTPException(status_code=403, detail=f"ID source {src} bloque (AUD-06)")

    # Find last known payload for source_id from log
    source_payload = None
    target_baseline = None
    try:
        log_path = main._resolve_log_path(request.mission_id, None, request.log_id)
        with open(str(log_path), "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                match = re.match(r"\([\d.]+\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
                if not match:
                    continue
                cid = match.group(1).upper()
                payload = match.group(2).upper()
                if cid == src:
                    source_payload = payload
                if cid == tgt:
                    target_baseline = payload
    except Exception:
        pass

    if not source_payload:
        raise HTTPException(
            status_code=400,
            detail=f"Aucun payload trouve pour l'ID source {src} dans le log. Impossible d'injecter."
        )

    window_s = request.window_ms / 1000.0
    pause_s = request.pause_ms / 1000.0
    results = []

    for attempt in range(request.repeat):
        # Start candump to monitor target
        monitor = await asyncio.create_subprocess_exec(
            "candump", "-ta", request.interface,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Small delay to let candump start
        await asyncio.sleep(0.02)

        # Record time and inject
        t_inject = time.time()
        success, error = main.can_send_frame(request.interface, src, source_payload)

        if not success:
            monitor.terminate()
            await monitor.wait()
            results.append({
                "attempt": attempt + 1,
                "injected": False,
                "error": error,
                "reaction": False,
                "lag_ms": None,
            })
            await asyncio.sleep(pause_s)
            continue

        # Monitor for target reaction within window
        reaction = False
        lag_ms = None
        deadline = t_inject + window_s

        try:
            while time.time() < deadline:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                try:
                    line_bytes = await asyncio.wait_for(
                        monitor.stdout.readline(),
                        timeout=remaining
                    )
                except asyncio.TimeoutError:
                    break

                if not line_bytes:
                    break

                decoded = line_bytes.decode().strip()
                if not decoded:
                    continue

                # Parse: (timestamp) interface ID#DATA
                parts = decoded.split()
                if len(parts) < 3:
                    continue
                frame_ts_str = parts[0].strip("()")
                frame_parts = parts[2].split("#")
                if len(frame_parts) != 2:
                    continue

                frame_id = frame_parts[0].upper()
                frame_payload = frame_parts[1].upper()

                # Check if this is our target AND payload changed from baseline
                if frame_id == tgt:
                    if target_baseline is None or frame_payload != target_baseline:
                        reaction = True
                        try:
                            frame_ts = float(frame_ts_str)
                            lag_ms = round((frame_ts - t_inject) * 1000, 2)
                        except ValueError:
                            lag_ms = round((time.time() - t_inject) * 1000, 2)
                        break
                    # Update baseline for next check
                    target_baseline = frame_payload
        finally:
            monitor.terminate()
            await monitor.wait()

        results.append({
            "attempt": attempt + 1,
            "injected": True,
            "error": None,
            "reaction": reaction,
            "lag_ms": lag_ms,
        })

        # Pause between attempts
        if attempt < request.repeat - 1:
            await asyncio.sleep(pause_s)

    # Aggregate
    successes = [r for r in results if r["reaction"]]
    attempts_ok = [r for r in results if r["injected"]]
    lags = [r["lag_ms"] for r in successes if r["lag_ms"] is not None]

    success_rate = len(successes) / len(attempts_ok) if attempts_ok else 0
    median_lag = sorted(lags)[len(lags) // 2] if lags else None
    min_lag = min(lags) if lags else None
    max_lag = max(lags) if lags else None

    # Classification
    if success_rate >= 0.7:
        classification = "high"
    elif success_rate >= 0.4:
        classification = "moderate"
    else:
        classification = "low"

    return {
        "status": "success",
        "source_id": src,
        "target_id": tgt,
        "source_payload": source_payload,
        "attempts": len(attempts_ok),
        "successes": len(successes),
        "success_rate": round(success_rate, 4),
        "median_lag_ms": median_lag,
        "min_lag_ms": min_lag,
        "max_lag_ms": max_lag,
        "classification": classification,
        "details": results,
    }



# =============================================================================
# Correlation inter-bus (routage gateway) - analyse offline de deux logs
# =============================================================================

class InterBusRequest(BaseModel):
    mission_id: str
    log_a_id: str  # bus A : prise directe
    log_b_id: str  # bus B : OBD
    window_ms: float = 20.0


_INTERBUS_LINE = re.compile(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)")


def _parse_interbus_log(log_file: Path) -> list:
    """Parse un log candump -L en [(ts, can_id, payload)] trie par temps.
    Pas de filtre OBD : le trafic 7E8 etc. est justement ce qu'on cherche."""
    frames = []
    with open(str(log_file), "r") as f:
        for line in f:
            m = _INTERBUS_LINE.match(line.strip())
            if m:
                frames.append((float(m.group(1)), m.group(2).upper(), m.group(3).upper()))
    frames.sort(key=lambda fr: fr[0])
    return frames


@router.post("/api/analysis/inter-bus-correlation")
async def inter_bus_correlation_endpoint(request: InterBusRequest):
    """
    Revele le routage gateway entre deux bus captures simultanement (horloge
    epoch commune) : pour chaque trame du bus A, quelles trames du bus B
    apparaissent dans les window_ms suivantes. Complexite O(A + B + matches)
    apres tri (pointeur glissant sur B), pas de produit A*B.
    """
    start_time = time.time()
    mission_dir = Path(main.MISSIONS_DIR) / main.sanitize_id(request.mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    log_a_file = mission_dir / "logs" / f"{main.sanitize_id(request.log_a_id)}.log"
    log_b_file = mission_dir / "logs" / f"{main.sanitize_id(request.log_b_id)}.log"
    if not log_a_file.exists():
        raise HTTPException(status_code=404, detail=f"Log A non trouve: {request.log_a_id}")
    if not log_b_file.exists():
        raise HTTPException(status_code=404, detail=f"Log B non trouve: {request.log_b_id}")

    window_s = max(request.window_ms, 0.0) / 1000.0
    frames_a = _parse_interbus_log(log_a_file)
    frames_b = _parse_interbus_log(log_b_file)
    b_ts = [fr[0] for fr in frames_b]

    count_a = {}       # id_a -> nb de trames A
    matched_a = set()  # id_a ayant eu au moins un echo en B
    agg = {}           # (id_a, id_b) -> [co, somme_delai_ms, nb_payload_identique]

    lo = 0
    for ts_a, id_a, pay_a in frames_a:
        count_a[id_a] = count_a.get(id_a, 0) + 1
        # A est trie : le premier B >= ts_a ne recule jamais
        if lo < len(b_ts) and b_ts[lo] < ts_a:
            lo = bisect_left(b_ts, ts_a, lo)
        seen = set()  # une seule co-occurrence par (trame A, id_b)
        j = lo
        limit = ts_a + window_s
        while j < len(b_ts) and b_ts[j] <= limit:
            ts_b, id_b, pay_b = frames_b[j]
            j += 1
            if id_b in seen:
                continue
            seen.add(id_b)
            rec = agg.setdefault((id_a, id_b), [0, 0.0, 0])
            rec[0] += 1
            rec[1] += (ts_b - ts_a) * 1000.0
            if pay_a == pay_b:
                rec[2] += 1
        if seen:
            matched_a.add(id_a)

    pairs = []
    for (id_a, id_b), (co, sum_delay, same) in agg.items():
        pairs.append({
            "id_a": id_a,
            "id_b": id_b,
            "co": co,
            "avg_delay_ms": round(sum_delay / co, 3),
            "p_forward": round(co / count_a[id_a], 4),
            "kind": "relay" if same / co >= 0.5 else "translated",
        })
    pairs.sort(key=lambda p: p["p_forward"] * p["co"], reverse=True)
    pairs = pairs[:50]

    blocked_ids = sorted(i for i in count_a if i not in matched_a)[:200]

    return {
        "status": "success",
        "pairs": pairs,
        "blocked_ids": blocked_ids,
        "total_a": len(frames_a),
        "total_b": len(frames_b),
        "elapsed_ms": round((time.time() - start_time) * 1000, 1),
    }
