#!/usr/bin/env python3
"""
AURIGE - candump log analyzer (pure Python, no deps).

Parses a CAN capture log and reports, per CAN ID:
  - frame count, mean cycle time (ms)
  - DLC, which byte positions change (and how often)
  - per-byte Shannon entropy (0 = constant, 8 = fully random)

Supports both candump formats used by AURIGE:
  candump -l  :  (1739530247.123456) can0 123#DEADBEEF
  candump -ta :  (1739530247.123456) can0 123 [8] DE AD BE EF 00 11 22 33

Usage:
  python3 analyze_log.py <file.log> [--id 123] [--top 20]
"""
import sys
import math
import argparse
from collections import defaultdict


def parse_line(line):
    """Return (timestamp: float, can_id: str, data_bytes: list[int]) or None."""
    line = line.strip()
    if not line.startswith("("):
        return None
    try:
        end = line.index(")")
        ts = float(line[1:end])
        rest = line[end + 1:].split()
        if len(rest) < 2:
            return None
        # rest[0] = interface, rest[1] = ID#DATA or ID
        token = rest[1]
        if "#" in token:  # candump -l format
            can_id, data = token.split("#", 1)
            data = data.split("#")[-1]  # drop CAN-FD flags if present
            bytes = [int(data[i:i + 2], 16) for i in range(0, len(data) - len(data) % 2, 2)]
            return ts, can_id.upper(), bytes
        # candump -ta format: ID [DLC] BB BB ...
        can_id = token.upper()
        data_tokens = [t for t in rest[2:] if len(t) == 2 and t != "[" ]
        # strip the [DLC] token
        data_tokens = [t for t in rest[2:] if not t.startswith("[") and not t.endswith("]")]
        bytes = []
        for t in data_tokens:
            try:
                bytes.append(int(t, 16))
            except ValueError:
                pass
        return ts, can_id, bytes
    except (ValueError, IndexError):
        return None


def entropy(values):
    """Shannon entropy in bits of a list of byte values."""
    if not values:
        return 0.0
    counts = defaultdict(int)
    for v in values:
        counts[v] += 1
    n = len(values)
    return abs(-sum((c / n) * math.log2(c / n) for c in counts.values()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--id", help="Filter on a single CAN ID (hex)", default=None)
    ap.add_argument("--top", type=int, default=30, help="Max IDs to display")
    args = ap.parse_args()

    frames = defaultdict(list)   # id -> [(ts, bytes)]
    total = 0
    with open(args.logfile, "r", errors="replace") as f:
        for line in f:
            p = parse_line(line)
            if p is None:
                continue
            ts, cid, byts = p
            if args.id and cid != args.id.upper():
                continue
            frames[cid].append((ts, byts))
            total += 1

    if not frames:
        print("Aucune trame reconnue. Verifier le format du log.")
        return

    rows = []
    for cid, fl in frames.items():
        n = len(fl)
        ts_list = [t for t, _ in fl]
        cycle = ((ts_list[-1] - ts_list[0]) / (n - 1) * 1000) if n > 1 else 0.0
        dlc = max((len(b) for _, b in fl), default=0)
        per_byte_ent = []
        changing = []
        for i in range(dlc):
            col = [b[i] for _, b in fl if i < len(b)]
            e = entropy(col)
            per_byte_ent.append(e)
            if len(set(col)) > 1:
                changing.append(i)
        rows.append((cid, n, cycle, dlc, changing, per_byte_ent))

    rows.sort(key=lambda r: r[1], reverse=True)

    print(f"Fichier      : {args.logfile}")
    print(f"Trames totales : {total}   |   IDs uniques : {len(frames)}\n")
    print(f"{'ID':<8}{'N':>7}{'cycle_ms':>10}{'DLC':>5}  bytes_variables (entropie/byte)")
    print("-" * 78)
    for cid, n, cycle, dlc, changing, ent in rows[:args.top]:
        ent_str = " ".join(f"{e:.1f}" for e in ent)
        chg = ",".join(str(c) for c in changing) if changing else "-"
        print(f"{cid:<8}{n:>7}{cycle:>10.1f}{dlc:>5}  [{chg}]  {ent_str}")

    if len(rows) > args.top:
        print(f"\n... {len(rows) - args.top} IDs supplementaires non affiches (--top {len(rows)}).")


if __name__ == "__main__":
    main()
