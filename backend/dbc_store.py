"""AURIGE - Stockage/édition DBC indépendant du support (mission ou bibliothèque).

Un "document DBC" est un dict:
  {messages:[{can_id, name, dlc, comment, signals:[DBCSignal]}], created_at, updated_at}
Ces helpers n'écrivent pas sur disque (sauf load_doc/save_doc); ils opèrent sur le dict.
"""
import re
import time
import json
from pathlib import Path
from datetime import datetime

_IDENT_KEEP = re.compile(r"[^A-Za-z0-9_]")


def dbc_ident(name, fallback):
    """Normalise un nom en identifiant DBC valide: [A-Za-z_][A-Za-z0-9_]*."""
    s = _IDENT_KEEP.sub("_", str(name or "").strip())
    if not s:
        return fallback
    if s[0].isdigit():
        s = "_" + s
    return s


def _dbc_str(s):
    """Échappe une chaîne pour un champ entre guillemets DBC."""
    return (str(s or "").replace("\\", "\\\\").replace('"', '\\"')
            .replace("\n", " ").replace("\r", " "))


def new_doc():
    now = datetime.now().isoformat()
    return {"messages": [], "created_at": now, "updated_at": now}


def load_doc(path: Path) -> dict:
    with open(path, "r") as f:
        return json.load(f)


def save_doc(path: Path, doc: dict) -> None:
    doc["updated_at"] = datetime.now().isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)


def _find_message(doc, can_id):
    for m in doc["messages"]:
        if m["can_id"] == can_id:
            return m
    return None


def upsert_message(doc, can_id, name=None, dlc=None, comment=None):
    """Crée le message si absent; met à jour UNIQUEMENT name/dlc/comment fournis.
    Ne touche jamais aux signaux."""
    can_id = str(can_id).upper()
    msg = _find_message(doc, can_id)
    if msg is None:
        msg = {"can_id": can_id, "name": f"MSG_{can_id}", "dlc": 8, "comment": "", "signals": []}
        doc["messages"].append(msg)
    if name is not None:
        msg["name"] = dbc_ident(name, f"MSG_{can_id}")
    if dlc is not None:
        msg["dlc"] = int(dlc)
    if comment is not None:
        msg["comment"] = str(comment)
    return None


def upsert_signal(doc, signal: dict) -> str:
    """Ajoute/maj un signal (match par id). Auto-crée le message de son can_id."""
    can_id = str(signal["can_id"]).upper()
    msg = _find_message(doc, can_id)
    if msg is None:
        msg = {"can_id": can_id, "name": f"MSG_{can_id}", "dlc": 8, "comment": "", "signals": []}
        doc["messages"].append(msg)
    sig = dict(signal)
    sig["can_id"] = can_id
    sig["name"] = dbc_ident(sig.get("name"), f"SIG_{can_id}_{sig.get('start_bit', 0)}")
    if not sig.get("id"):
        sig["id"] = f"{can_id}_{sig['name']}_{datetime.now().strftime('%H%M%S')}{int(time.time()*1000)%1000}"
    idx = next((i for i, s in enumerate(msg["signals"]) if s.get("id") == sig["id"]), None)
    if idx is not None:
        msg["signals"][idx] = sig
    else:
        msg["signals"].append(sig)
    return sig["id"]


def delete_signal(doc, signal_id: str) -> int:
    removed = 0
    for m in doc["messages"]:
        before = len(m["signals"])
        m["signals"] = [s for s in m["signals"] if s.get("id") != signal_id]
        removed += before - len(m["signals"])
    return removed


def delete_message(doc, can_id: str) -> int:
    before = len(doc["messages"])
    doc["messages"] = [m for m in doc["messages"] if m.get("can_id") != can_id]
    return before - len(doc["messages"])


# Liste standard des symboles NS_ (compat candb++/SavvyCAN).
_NS_SYMBOLS = [
    "NS_DESC_", "CM_", "BA_DEF_", "BA_", "VAL_", "CAT_DEF_", "CAT_", "FILTER",
    "BA_DEF_DEF_", "EV_DATA_", "ENVVAR_DATA_", "SGTYPE_", "SGTYPE_VAL_",
    "BA_DEF_SGTYPE_", "BA_SGTYPE_", "SIG_TYPE_REF_", "VAL_TABLE_", "SIG_GROUP_",
    "SIG_VALTYPE_", "SIGTYPE_VALTYPE_", "BO_TX_BU_", "BA_DEF_REL_", "BA_REL_",
    "BA_DEF_DEF_REL_", "BU_SG_REL_", "BU_EV_REL_", "BU_BO_REL_", "SG_MUL_VAL_",
]


def dbc_to_text(doc: dict) -> str:
    lines = ['VERSION ""', "", "NS_ :"]
    for sym in _NS_SYMBOLS:
        lines.append(f"\t{sym}")
    lines += ["", "BS_:", "", "BU_:", ""]
    for msg in doc.get("messages", []):
        bo_id = int(msg["can_id"], 16)
        if bo_id > 0x7FF:
            bo_id |= 0x80000000
        name = dbc_ident(msg.get("name"), f"MSG_{msg['can_id']}")
        dlc = int(msg.get("dlc", 8))
        lines.append(f"BO_ {bo_id} {name}: {dlc} Vector__XXX")
        for sig in msg.get("signals", []):
            sname = dbc_ident(sig.get("name"), f"SIG_{msg['can_id']}_{sig.get('start_bit',0)}")
            bo = 1 if sig.get("byte_order") == "little_endian" else 0
            sign = "-" if sig.get("is_signed") else "+"
            scale = sig.get("scale", 1)
            offset = sig.get("offset", 0)
            mn = sig.get("min_val", 0)
            mx = sig.get("max_val", 0)
            unit = sig.get("unit", "")
            lines.append(
                f' SG_ {sname} : {sig.get("start_bit",0)}|{sig.get("length",8)}@{bo}{sign}'
                f' ({scale},{offset}) [{mn}|{mx}] "{_dbc_str(unit)}" Vector__XXX'
            )
        lines.append("")
    lines.append("")
    for msg in doc.get("messages", []):
        bo_id = int(msg["can_id"], 16)
        if bo_id > 0x7FF:
            bo_id |= 0x80000000
        if msg.get("comment"):
            lines.append(f'CM_ BO_ {bo_id} "{_dbc_str(msg["comment"])}";')
        for sig in msg.get("signals", []):
            if sig.get("comment"):
                sname = dbc_ident(sig.get("name"), f"SIG_{msg['can_id']}_{sig.get('start_bit',0)}")
                lines.append(f'CM_ SG_ {bo_id} {sname} "{_dbc_str(sig["comment"])}";')
    return "\n".join(lines)
