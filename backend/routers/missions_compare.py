"""AURIGE - Comparaison / import / export de missions.
Extrait de main.py, routes inchangees. Modeles Pydantic et helpers restent dans
main.py (router inclus en fin de main.py). Helpers appeles via main.<nom> a l'execution."""
import json
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Response, UploadFile

import main
from main import (
    CompareFrameDiff,
    CompareLogsRequest,
    CompareLogsResponse,
    ImportLogResponse,
    SavedComparisonRequest,
)

router = APIRouter()


@router.post("/api/missions/{mission_id}/compare-logs", response_model=CompareLogsResponse)
async def compare_logs(mission_id: str, request: CompareLogsRequest):
    """Compare two logs to identify differential frames between states (e.g., open vs closed)"""
    from collections import Counter, defaultdict
    
    mission_dir = Path(main.MISSIONS_DIR) / main.sanitize_id(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    
    log_a_file = mission_dir / "logs" / f"{main.sanitize_id(request.log_a_id)}.log"
    log_b_file = mission_dir / "logs" / f"{main.sanitize_id(request.log_b_id)}.log"
    
    if not log_a_file.exists():
        raise HTTPException(status_code=404, detail=f"Log A non trouve: {request.log_a_id}")
    if not log_b_file.exists():
        raise HTTPException(status_code=404, detail=f"Log B non trouve: {request.log_b_id}")
    
    def parse_log(log_file: Path) -> tuple[dict[str, list[str]], dict[str, dict[str, list[float]]]]:
        """Parse log and return:
        - dict of can_id -> list of payloads
        - dict of can_id -> { payload -> [timestamps] }
        """
        frames = defaultdict(list)
        payload_timestamps = defaultdict(lambda: defaultdict(list))
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
                if match:
                    ts = float(match.group(1))
                    can_id = match.group(2).upper()
                    data = match.group(3).upper()
                    frames[can_id].append(data)
                    payload_timestamps[can_id][data].append(ts)
        return dict(frames), dict(payload_timestamps)
    
    def get_most_common(data_list: list[str]) -> str:
        if not data_list:
            return ""
        return Counter(data_list).most_common(1)[0][0]
    
    def analyze_byte_stability(payloads: list[str]) -> list[dict]:
        """
        Analyze each byte position across all payloads.
        Returns per-byte: unique values, most common value, stability ratio.
        
        A byte is 'stable' if it has the same value in >80% of payloads.
        A byte is 'variable' (counter/timestamp) if it has many unique values.
        """
        if not payloads:
            return []
        
        # Normalize payload length
        max_bytes = max(len(p) // 2 for p in payloads) if payloads else 0
        result = []
        
        for byte_idx in range(max_bytes):
            values = []
            for p in payloads:
                start = byte_idx * 2
                if start + 2 <= len(p):
                    values.append(p[start:start+2])
                else:
                    values.append("00")
            
            counter = Counter(values)
            most_common_val = counter.most_common(1)[0][0]
            most_common_count = counter.most_common(1)[0][1]
            unique_count = len(counter)
            stability = round(most_common_count / len(values) * 100, 1) if values else 0
            
            result.append({
                "index": byte_idx,
                "most_common": most_common_val,
                "unique_count": unique_count,
                "stability": stability,
                "is_stable": stability >= 70,  # >70% = stable byte
                "is_counter": unique_count > len(values) * 0.3,  # Many unique = counter
            })
        
        return result
    
    def build_representative_payload(byte_analysis: list[dict]) -> str:
        """Build a representative payload from per-byte analysis."""
        return "".join(b["most_common"] for b in byte_analysis)
    
    # Parse both logs (with timestamps)
    frames_a, ts_map_a = parse_log(log_a_file)
    frames_b, ts_map_b = parse_log(log_b_file)
    
    # Get all unique CAN IDs
    all_ids = set(frames_a.keys()) | set(frames_b.keys())
    
    # Compare each ID
    results = []
    differential_count = 0
    only_a_count = 0
    only_b_count = 0
    identical_count = 0
    
    for can_id in sorted(all_ids):
        payloads_a = frames_a.get(can_id, [])
        payloads_b = frames_b.get(can_id, [])
        
        # Per-byte stability analysis (key improvement)
        bytes_analysis_a = analyze_byte_stability(payloads_a)
        bytes_analysis_b = analyze_byte_stability(payloads_b)
        
        # Build representative payloads from most common byte values
        payload_a = build_representative_payload(bytes_analysis_a) if bytes_analysis_a else ""
        payload_b = build_representative_payload(bytes_analysis_b) if bytes_analysis_b else ""
        
        # Count unique payloads in each log
        unique_a = len(set(payloads_a)) if payloads_a else 0
        unique_b = len(set(payloads_b)) if payloads_b else 0
        
        # Dominant ratio: how much the most common payload dominates
        dominant_a = 0.0
        dominant_b = 0.0
        if payloads_a:
            counter_a = Counter(payloads_a)
            dominant_a = round(counter_a.most_common(1)[0][1] / len(payloads_a) * 100, 1)
        if payloads_b:
            counter_b = Counter(payloads_b)
            dominant_b = round(counter_b.most_common(1)[0][1] / len(payloads_b) * 100, 1)
        
        # ============================================================
        # SMART CLASSIFICATION
        # Compare per-byte using two approaches:
        # 1. Stable bytes: flag if stable in both but different
        # 2. Variable bytes: compare MEDIAN values - if distributions
        #    are significantly separated, flag as differential
        # This catches sensor values that shift range between states.
        # ============================================================
        if not payloads_a:
            classification = "only_b"
            only_b_count += 1
            confidence = 80.0
        elif not payloads_b:
            classification = "only_a"
            only_a_count += 1
            confidence = 80.0
        else:
            max_bytes = max(len(bytes_analysis_a), len(bytes_analysis_b))
            stable_diff_count = 0
            variable_diff_count = 0
            any_stable_diff = False
            any_variable_diff = False
            
            for i in range(max_bytes):
                ba = bytes_analysis_a[i] if i < len(bytes_analysis_a) else None
                bb = bytes_analysis_b[i] if i < len(bytes_analysis_b) else None
                
                if ba and bb:
                    both_stable = ba["is_stable"] and bb["is_stable"]
                    values_differ = ba["most_common"] != bb["most_common"]
                    is_counter = ba.get("is_counter", False) or bb.get("is_counter", False)
                    
                    if both_stable and values_differ:
                        # Case 1: Both bytes are stable but have different dominant values
                        stable_diff_count += 1
                        any_stable_diff = True
                    elif not both_stable:
                        # Case 2+3: Byte is not stable in at least one log
                        # Compare the VALUE DISTRIBUTIONS between logs
                        # This catches: toggle bytes (95/55), state bytes, counters, sensors
                        vals_a_hex = []
                        vals_b_hex = []
                        vals_a_int = []
                        vals_b_int = []
                        for p in payloads_a:
                            start = i * 2
                            if start + 2 <= len(p):
                                hv = p[start:start+2]
                                vals_a_hex.append(hv)
                                try:
                                    vals_a_int.append(int(hv, 16))
                                except ValueError:
                                    pass
                        for p in payloads_b:
                            start = i * 2
                            if start + 2 <= len(p):
                                hv = p[start:start+2]
                                vals_b_hex.append(hv)
                                try:
                                    vals_b_int.append(int(hv, 16))
                                except ValueError:
                                    pass
                        
                        if vals_a_int and vals_b_int:
                            # For non-counter bytes (toggle/state with few values):
                            # Compare value distribution directly
                            counter_a = Counter(vals_a_hex)
                            counter_b = Counter(vals_b_hex)
                            
                            # Calculate distribution similarity using frequency comparison
                            all_vals = set(counter_a.keys()) | set(counter_b.keys())
                            total_a = len(vals_a_hex)
                            total_b = len(vals_b_hex)
                            
                            distribution_diff = 0.0
                            for v in all_vals:
                                freq_a = counter_a.get(v, 0) / total_a if total_a else 0
                                freq_b = counter_b.get(v, 0) / total_b if total_b else 0
                                distribution_diff += abs(freq_a - freq_b)
                            
                            # distribution_diff ranges 0-2 (0=identical, 2=completely different)
                            
                            sorted_a = sorted(vals_a_int)
                            sorted_b = sorted(vals_b_int)
                            median_a = sorted_a[len(sorted_a) // 2]
                            median_b = sorted_b[len(sorted_b) // 2]
                            median_diff = abs(median_a - median_b)
                            
                            # Check range overlap
                            min_a, max_a = min(vals_a_int), max(vals_a_int)
                            min_b, max_b = min(vals_b_int), max(vals_b_int)
                            overlap_start = max(min_a, min_b)
                            overlap_end = min(max_a, max_b)
                            range_a = max_a - min_a + 1
                            range_b = max_b - min_b + 1
                            overlap = max(0, overlap_end - overlap_start + 1)
                            max_range = max(range_a, range_b, 1)
                            overlap_ratio = overlap / max_range
                            
                            # Flag as differential if ANY of these conditions:
                            # - Distribution significantly different (>0.5 on 0-2 scale)
                            # - Medians differ by >15 (sensor shift)
                            # - Ranges barely overlap (<30%) with some median diff
                            # - Most common value is different AND byte has few unique vals (toggle)
                            is_toggle = (ba["unique_count"] <= 5 and bb["unique_count"] <= 5)
                            most_common_differs = ba["most_common"] != bb["most_common"]
                            
                            if (distribution_diff > 0.5
                                or median_diff > 15
                                or (overlap_ratio < 0.3 and median_diff > 5)
                                or (is_toggle and most_common_differs and distribution_diff > 0.3)):
                                variable_diff_count += 1
                                any_variable_diff = True
            
            if any_stable_diff or any_variable_diff:
                classification = "differential"
                differential_count += 1
                total_diffs = stable_diff_count + variable_diff_count
                confidence = min(95.0, 60.0 + total_diffs * 8 + min(len(payloads_a), len(payloads_b)) * 0.5)
                if any_variable_diff and not any_stable_diff:
                    # Lower confidence for variable-only diffs
                    confidence = min(85.0, confidence)
            elif payload_a == payload_b:
                classification = "identical"
                identical_count += 1
                confidence = 95.0
            else:
                # Payloads differ but only on counter/variable bytes with overlapping ranges
                classification = "identical"
                identical_count += 1
                confidence = 70.0
        
        # Find changed bytes with detail
        # Flag stable bytes that differ AND variable bytes with distribution shift
        bytes_changed = []
        byte_change_detail = []
        if payload_a and payload_b:
            max_len = max(len(payload_a), len(payload_b))
            pa = payload_a.ljust(max_len, "0")
            pb = payload_b.ljust(max_len, "0")
            for i in range(0, max_len, 2):
                byte_a = pa[i:i+2]
                byte_b = pb[i:i+2]
                byte_idx = i // 2
                
                # Check if this byte is a counter/variable
                ba = bytes_analysis_a[byte_idx] if byte_idx < len(bytes_analysis_a) else None
                bb = bytes_analysis_b[byte_idx] if byte_idx < len(bytes_analysis_b) else None
                is_counter = False
                if ba and bb:
                    is_counter = ba.get("is_counter", False) or bb.get("is_counter", False)
                
                # For unstable bytes, check if distributions are significantly different
                is_significant_diff = False
                both_stable_here = False
                if ba and bb:
                    both_stable_here = ba["is_stable"] and bb["is_stable"]
                
                if not both_stable_here and ba and bb:
                    vals_a_hex = []
                    vals_b_hex = []
                    vals_a_int = []
                    vals_b_int = []
                    for p in payloads_a:
                        start = byte_idx * 2
                        if start + 2 <= len(p):
                            hv = p[start:start+2]
                            vals_a_hex.append(hv)
                            try:
                                vals_a_int.append(int(hv, 16))
                            except ValueError:
                                pass
                    for p in payloads_b:
                        start = byte_idx * 2
                        if start + 2 <= len(p):
                            hv = p[start:start+2]
                            vals_b_hex.append(hv)
                            try:
                                vals_b_int.append(int(hv, 16))
                            except ValueError:
                                pass
                    if vals_a_int and vals_b_int:
                        counter_va = Counter(vals_a_hex)
                        counter_vb = Counter(vals_b_hex)
                        total_a = len(vals_a_hex)
                        total_b = len(vals_b_hex)
                        all_vals = set(counter_va.keys()) | set(counter_vb.keys())
                        distribution_diff = 0.0
                        for v in all_vals:
                            freq_a = counter_va.get(v, 0) / total_a if total_a else 0
                            freq_b = counter_vb.get(v, 0) / total_b if total_b else 0
                            distribution_diff += abs(freq_a - freq_b)
                        
                        median_a = sorted(vals_a_int)[len(vals_a_int) // 2]
                        median_b = sorted(vals_b_int)[len(vals_b_int) // 2]
                        median_diff = abs(median_a - median_b)
                        min_a, max_a = min(vals_a_int), max(vals_a_int)
                        min_b, max_b = min(vals_b_int), max(vals_b_int)
                        overlap_start = max(min_a, min_b)
                        overlap_end = min(max_a, max_b)
                        overlap = max(0, overlap_end - overlap_start + 1)
                        max_range = max(max_a - min_a + 1, max_b - min_b + 1, 1)
                        overlap_ratio = overlap / max_range
                        
                        is_toggle = (ba["unique_count"] <= 5 and bb["unique_count"] <= 5)
                        most_common_differs = ba["most_common"] != bb["most_common"]
                        
                        if (distribution_diff > 0.5
                            or median_diff > 15
                            or (overlap_ratio < 0.3 and median_diff > 5)
                            or (is_toggle and most_common_differs and distribution_diff > 0.3)):
                            is_significant_diff = True
                
                # Include byte as changed if:
                # - It's a stable byte that differs
                # - Or it's an unstable byte with significant distribution change
                if byte_a != byte_b and (both_stable_here or is_significant_diff):
                    bytes_changed.append(byte_idx)
                    try:
                        val_a = int(byte_a, 16)
                        val_b = int(byte_b, 16)
                        byte_change_detail.append({
                            "index": byte_idx,
                            "val_a": byte_a,
                            "val_b": byte_b,
                            "hex_diff": f"{abs(val_a - val_b):02X}",
                            "decimal_diff": abs(val_a - val_b),
                            "changed_bits": [bit for bit in range(8) if (val_a ^ val_b) >> bit & 1],
                        })
                    except ValueError:
                        byte_change_detail.append({
                            "index": byte_idx,
                            "val_a": byte_a,
                            "val_b": byte_b,
                            "hex_diff": "??",
                            "decimal_diff": 0,
                            "changed_bits": [],
                        })
        
        # ============================================================
        # STABILITY SCORE (0-100)
        # Higher = better candidate for reverse engineering
        #
        # Uses per-byte analysis: a perfect candidate has
        #   - Stable bytes that differ cleanly between A and B
        #   - Few bytes changed (targeted signal)
        #   - High sample count for confidence
        # ============================================================
        stability = 0.0
        
        if classification == "differential":
            # 1. Byte-level stability (40 pts max)
            #    Average stability of the CHANGED bytes
            if bytes_changed:
                changed_stabilities = []
                for bi in bytes_changed:
                    sa = bytes_analysis_a[bi]["stability"] if bi < len(bytes_analysis_a) else 0
                    sb = bytes_analysis_b[bi]["stability"] if bi < len(bytes_analysis_b) else 0
                    changed_stabilities.append((sa + sb) / 2)
                avg_stability = sum(changed_stabilities) / len(changed_stabilities)
                stability += min(40.0, avg_stability * 0.4)
            
            # 2. Targeted change (30 pts max)
            #    Fewer stable bytes changed = more precise signal
            n_bytes_changed = len(bytes_changed)
            if n_bytes_changed == 1:
                stability += 30.0  # Perfect: single byte toggle
            elif n_bytes_changed == 2:
                stability += 22.0
            elif n_bytes_changed <= 4:
                stability += 12.0
            elif n_bytes_changed <= 6:
                stability += 5.0
            
            # 3. Sample count (20 pts max)
            min_count = min(len(payloads_a), len(payloads_b))
            if min_count >= 50:
                stability += 20.0
            elif min_count >= 20:
                stability += 14.0
            elif min_count >= 10:
                stability += 8.0
            elif min_count >= 5:
                stability += 4.0
            
            # 4. Clean separation bonus (10 pts max)
            #    If changed bytes have no overlap in values between A and B
            if bytes_changed and len(payloads_a) >= 3 and len(payloads_b) >= 3:
                clean_separation = True
                for bi in bytes_changed:
                    vals_a = set()
                    vals_b = set()
                    for p in payloads_a:
                        start = bi * 2
                        if start + 2 <= len(p):
                            vals_a.add(p[start:start+2])
                    for p in payloads_b:
                        start = bi * 2
                        if start + 2 <= len(p):
                            vals_b.add(p[start:start+2])
                    if vals_a & vals_b:  # Overlap
                        clean_separation = False
                        break
                if clean_separation:
                    stability += 10.0
            
            stability = min(100.0, round(stability, 1))
        
        elif classification in ("only_a", "only_b"):
            # Frames only in one log: could be interesting if very stable
            payloads = payloads_a if classification == "only_a" else payloads_b
            dominant = dominant_a if classification == "only_a" else dominant_b
            unique = unique_a if classification == "only_a" else unique_b
            
            if unique <= 1:
                stability = 70.0
            elif unique <= 3:
                stability = 50.0
            else:
                stability = max(10.0, dominant * 0.3)
            stability = round(stability, 1)
        
        # ============================================================
        # COMMANDE PROBABLE: rare/exclusif analysis
        # Payloads rares = count <= rareThreshold (default 1)
        # Exclusifs = rares dans A absents de B (et vice versa)
        # ============================================================
        rare_threshold = 1  # configurable via frontend later
        
        payload_counts_a = Counter(payloads_a) if payloads_a else Counter()
        payload_counts_b = Counter(payloads_b) if payloads_b else Counter()
        ts_a = ts_map_a.get(can_id, {})
        ts_b = ts_map_b.get(can_id, {})
        
        def make_rare_list(payload_counter, ts_map_for_id, threshold):
            rares = []
            for payload, count in payload_counter.items():
                if count <= threshold:
                    timestamps = ts_map_for_id.get(payload, [])
                    rares.append({
                        "payload": payload,
                        "count": count,
                        "ts_preview": [round(t, 4) for t in timestamps[:3]]
                    })
            return rares
        
        rare_a = make_rare_list(payload_counts_a, ts_a, rare_threshold)
        rare_b = make_rare_list(payload_counts_b, ts_b, rare_threshold)
        
        rare_a_payloads = {r["payload"] for r in rare_a}
        rare_b_payloads = {r["payload"] for r in rare_b}
        
        exclusive_a = [r for r in rare_a if r["payload"] not in payload_counts_b]
        exclusive_b = [r for r in rare_b if r["payload"] not in payload_counts_a]
        
        # Command score calculation (0-100)
        cmd_score = 0.0
        
        # Boost principal: exclusifs presents
        if exclusive_a:
            cmd_score += 45
        if exclusive_b:
            cmd_score += 45
        
        # Rarete: bonus par payload exclusif
        for ep in exclusive_a + exclusive_b:
            if ep["count"] == 1:
                cmd_score += 15
            elif ep["count"] == 2:
                cmd_score += 8
        
        # Concentration temporelle: si tous les timestamps d'un payload exclusif
        # sont concentres en < 0.5s -> boost
        for ep in exclusive_a:
            tsl = ts_a.get(ep["payload"], [])
            if len(tsl) >= 1 and (max(tsl) - min(tsl)) < 0.5:
                cmd_score += 10
        for ep in exclusive_b:
            tsl = ts_b.get(ep["payload"], [])
            if len(tsl) >= 1 and (max(tsl) - min(tsl)) < 0.5:
                cmd_score += 10
        
        # Malus trame d'etat cyclique
        total_frames_both = len(payloads_a) + len(payloads_b)
        if payloads_a:
            top_count_a = payload_counts_a.most_common(1)[0][1]
            top_pct_a = top_count_a / len(payloads_a)
        else:
            top_pct_a = 0
        if payloads_b:
            top_count_b = payload_counts_b.most_common(1)[0][1]
            top_pct_b = top_count_b / len(payloads_b)
        else:
            top_pct_b = 0
        top_pct = max(top_pct_a, top_pct_b)
        
        if total_frames_both > 300 and top_pct > 0.85:
            cmd_score -= 35
        elif total_frames_both > 150 and top_pct > 0.7:
            cmd_score -= 25
        
        cmd_score = min(100.0, max(0.0, cmd_score))
        
        # Only include interesting frames (not identical unless few)
        if classification != "identical" or len(all_ids) < 50:
            results.append(CompareFrameDiff(
                can_id=can_id,
                payload_a=payload_a,
                payload_b=payload_b,
                count_a=len(payloads_a),
                count_b=len(payloads_b),
                bytes_changed=bytes_changed,
                classification=classification,
                confidence=confidence,
                unique_payloads_a=unique_a,
                unique_payloads_b=unique_b,
                stability_score=stability,
                dominant_ratio_a=dominant_a,
                dominant_ratio_b=dominant_b,
                byte_change_detail=byte_change_detail,
                command_score=round(cmd_score, 1),
                rare_payloads_a=rare_a,
                rare_payloads_b=rare_b,
                exclusive_rare_a=exclusive_a,
                exclusive_rare_b=exclusive_b,
            ))
    
    # Sort: differential first, then by stability_score DESC (most stable = best for reverse)
    priority = {"differential": 0, "only_a": 1, "only_b": 2, "identical": 3}
    results.sort(key=lambda x: (priority.get(x.classification, 4), -x.stability_score, -x.confidence))
    
    return CompareLogsResponse(
        log_a_name=request.log_a_id,
        log_b_name=request.log_b_id,
        total_ids_a=len(frames_a),
        total_ids_b=len(frames_b),
        differential_count=differential_count,
        only_a_count=only_a_count,
        only_b_count=only_b_count,
        identical_count=identical_count,
        frames=results
    )


@router.post("/api/missions/{mission_id}/import-log", response_model=ImportLogResponse)
async def import_log(mission_id: str, file: UploadFile = File(...)):
    """Import an external log file into a mission"""
    mission_dir = Path(main.MISSIONS_DIR) / main.sanitize_id(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    
    logs_dir = mission_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    
    # Validate file extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="Nom de fichier requis")
    
    if not file.filename.endswith(".log"):
        raise HTTPException(status_code=400, detail="Le fichier doit etre un .log")
    
    # Generate unique filename to avoid conflicts
    base_name = file.filename.replace(".log", "")
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', base_name)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_id = f"imported_{safe_name}_{timestamp}"
    log_filename = f"{log_id}.log"
    log_path = logs_dir / log_filename
    
    # Read and validate content (max 100MB)
    content = await file.read()
    if len(content) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux (max 100 Mo)")
    try:
        text_content = content.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Le fichier doit etre en UTF-8")
    
    # Count valid CAN frames
    frames_count = 0
    valid_lines = []
    for line in text_content.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Validate CAN log format: (timestamp) interface CANID#DATA
        match = re.match(r"\((\d+\.?\d*)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
        if match:
            frames_count += 1
            valid_lines.append(line)
    
    if frames_count == 0:
        raise HTTPException(status_code=400, detail="Aucune trame CAN valide trouvee dans le fichier")
    
    # Save the file
    with open(log_path, "w") as f:
        f.write("\n".join(valid_lines))
    
    return ImportLogResponse(
        id=log_id,
        filename=log_filename,
        frames_count=frames_count,
        message=f"Log importe avec {frames_count} trames"
    )


@router.get("/api/missions/{mission_id}/comparisons")
async def list_comparisons(mission_id: str):
    """List all saved comparisons for a mission"""
    mission_dir = Path(main.MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    comparisons = main.load_comparisons(mission_id)
    # Return without full result data for list view
    return [
        {
            "id": c["id"],
            "name": c["name"],
            "log_a_id": c["log_a_id"],
            "log_a_name": c["log_a_name"],
            "log_b_id": c["log_b_id"],
            "log_b_name": c["log_b_name"],
            "created_at": c["created_at"],
            "differential_count": c.get("result", {}).get("differential_count", 0),
            "only_a_count": c.get("result", {}).get("only_a_count", 0),
            "only_b_count": c.get("result", {}).get("only_b_count", 0),
            "identical_count": c.get("result", {}).get("identical_count", 0),
        }
        for c in comparisons
    ]


@router.post("/api/missions/{mission_id}/comparisons")
async def save_comparison(mission_id: str, req: SavedComparisonRequest):
    """Save a comparison result"""
    mission_dir = Path(main.MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    
    comparisons = main.load_comparisons(mission_id)
    
    comp_id = f"comp_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{len(comparisons)}"
    new_comp = {
        "id": comp_id,
        "name": req.name,
        "log_a_id": req.log_a_id,
        "log_a_name": req.log_a_name,
        "log_b_id": req.log_b_id,
        "log_b_name": req.log_b_name,
        "created_at": datetime.now().isoformat(),
        "result": req.result,
    }
    comparisons.append(new_comp)
    main.save_comparisons(mission_id, comparisons)
    
    return new_comp


@router.get("/api/missions/{mission_id}/comparisons/{comparison_id}")
async def get_comparison(mission_id: str, comparison_id: str):
    """Get a single saved comparison with full result"""
    comparisons = main.load_comparisons(mission_id)
    for c in comparisons:
        if c["id"] == comparison_id:
            return c
    raise HTTPException(status_code=404, detail="Comparaison non trouvee")


@router.delete("/api/missions/{mission_id}/comparisons/{comparison_id}")
async def delete_comparison(mission_id: str, comparison_id: str):
    """Delete a saved comparison"""
    comparisons = main.load_comparisons(mission_id)
    new_comparisons = [c for c in comparisons if c["id"] != comparison_id]
    if len(new_comparisons) == len(comparisons):
        raise HTTPException(status_code=404, detail="Comparaison non trouvee")
    main.save_comparisons(mission_id, new_comparisons)
    return {"status": "deleted", "id": comparison_id}


@router.get("/api/missions/{mission_id}/export")
async def export_mission(mission_id: str):
    """Export all mission data as a ZIP archive"""
    import zipfile
    import io
    import re
    from datetime import datetime
    
    try:
        mission_dir = main.MISSIONS_DIR / mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail="Mission not found")
        
        # Load mission metadata
        metadata_file = mission_dir / "mission.json"
        mission_name = mission_id
        if metadata_file.exists():
            with open(metadata_file, "r") as f:
                meta = json.load(f)
                mission_name = meta.get("name", mission_id)
        
        # Sanitize mission name for filesystem
        safe_name = re.sub(r'[^\w\-_]', '_', mission_name)
        
        # Create ZIP in memory
        buffer = io.BytesIO()
        
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            # Add mission metadata
            if metadata_file.exists():
                zf.write(metadata_file, f"{safe_name}/mission.json")
            
            # Add all .log files (CAN captures)
            logs_dir = mission_dir / "logs"
            if logs_dir.exists():
                for log_file in logs_dir.glob("*.log"):
                    zf.write(log_file, f"{safe_name}/logs/{log_file.name}")
            
            # Add isolation logs
            isolation_dir = mission_dir / "isolation"
            if isolation_dir.exists():
                for log_file in isolation_dir.rglob("*.log"):
                    rel_path = log_file.relative_to(isolation_dir)
                    zf.write(log_file, f"{safe_name}/isolation/{rel_path}")
            
            # Add DBC file if exists
            dbc_file = mission_dir / "dbc.json"
            if dbc_file.exists():
                zf.write(dbc_file, f"{safe_name}/dbc.json")
                
                # Also generate and include the actual DBC file
                try:
                    with open(dbc_file, "r") as f:
                        dbc_data = json.load(f)
                    
                    # Generate DBC content
                    dbc_lines = [
                        'VERSION ""',
                        '',
                        'NS_ :',
                        '',
                        'BS_:',
                        '',
                        'BU_:',
                        '',
                    ]
                    
                    # Get messages with signals from the dbc.json structure
                    messages = dbc_data.get("messages", [])
                    signals_by_id = {}
                    for msg in messages:
                        can_id = msg.get("can_id", "000")
                        if can_id not in signals_by_id:
                            signals_by_id[can_id] = []
                        signals_by_id[can_id].extend(msg.get("signals", []))
                    
                    # Generate BO_ (message) and SG_ (signal) entries
                    for can_id, sigs in signals_by_id.items():
                        can_id_int = int(can_id, 16)
                        msg_name = f"MSG_{can_id}"
                        dbc_lines.append(f'BO_ {can_id_int} {msg_name}: 8 Vector__XXX')
                        
                        for sig in sigs:
                            name = sig.get("name", f"SIG_{can_id}")
                            start_bit = sig.get("start_bit", 0)
                            length = sig.get("length", 8)
                            byte_order = 1 if sig.get("byte_order") == "little_endian" else 0
                            is_signed = "-" if sig.get("is_signed") else "+"
                            scale = sig.get("scale", 1)
                            offset = sig.get("offset", 0)
                            min_val = sig.get("min_val", 0)
                            max_val = sig.get("max_val", 255)
                            unit = sig.get("unit", "")
                            
                            dbc_lines.append(f' SG_ {name} : {start_bit}|{length}@{byte_order}{is_signed} ({scale},{offset}) [{min_val}|{max_val}] "{unit}" Vector__XXX')
                        
                        dbc_lines.append('')
                    
                    # Add comments
                    dbc_lines.append('')
                    for can_id, sigs in signals_by_id.items():
                        for sig in sigs:
                            comment = sig.get("comment", "")
                            if comment:
                                can_id_int = int(can_id, 16)
                                name = sig.get("name", f"SIG_{can_id}")
                                dbc_lines.append(f'CM_ SG_ {can_id_int} {name} "{comment}";')
                    
                    dbc_content = "\n".join(dbc_lines)
                    zf.writestr(f"{safe_name}/{safe_name}.dbc", dbc_content)
                except Exception as e:
                    print(f"[WARNING] Could not generate DBC: {e}")
            
            # Add comparisons file if exists
            comp_file = mission_dir / "comparisons.json"
            if comp_file.exists():
                zf.write(comp_file, f"{safe_name}/comparisons.json")
            
            # Add a README
            readme = f"""# Mission Export: {mission_name}
Exported: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

## Contents:
- mission.json: Mission metadata
- logs/: CAN bus capture files (.log)
- isolation/: Isolated log files from analysis
- dbc.json: DBC signals data (JSON format)
- {safe_name}.dbc: Generated DBC file (standard format)
- comparisons.json: Saved log comparisons

## Usage:
- Import .log files into any CAN analysis tool
- Use the .dbc file with CANalyzer, SavvyCAN, or similar tools
"""
            zf.writestr(f"{safe_name}/README.txt", readme)
        
        buffer.seek(0)
        
        # Generate filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{safe_name}_{timestamp}.zip"
        
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Export mission failed: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")
