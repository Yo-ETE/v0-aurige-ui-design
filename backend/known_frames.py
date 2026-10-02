"""
AURIGE - Bibliotheque globale des trames CAN connues (crash / reinit).

Helpers purs (pas de FastAPI ici) : stockage JSON sous AURIGE_DATA_DIR,
sauvegarde atomique, validation hex. Les endpoints HTTP (main.py) convertissent
les ValueError de validation en reponses 400.

Exemple Peugeot : 4C8#0003000000000000 (crash) / 4C8#0000000000000000 (reset).
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# Recalcule DATA_DIR depuis l'env exactement comme main.py (pas d'import croise :
# main.py importe ce module, jamais l'inverse). Chemin monkeypatchable par les tests.
DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
KNOWN_FRAMES_PATH = DATA_DIR / "known_frames.json"

# Regex ancrees ^...$ appliquees avec re.match sur une valeur deja .strip() ; or `$`
# accepte un saut de ligne final, d'ou le .strip() prealable. main.py revalide de plus
# la trame stockee avec fullmatch avant tout rejeu.
_HEX_ID_RE = re.compile(r"^[0-9A-Fa-f]{1,8}$")
_HEX_DATA_RE = re.compile(r"^([0-9A-Fa-f]{2}){0,8}$")

SEVERITIES = {"info", "warning", "danger"}
DEFAULT_SEVERITY = "danger"


def _validate_hex_id(can_id) -> str:
    if not isinstance(can_id, str) or not _HEX_ID_RE.match(can_id.strip()):
        raise ValueError(f"can_id invalide (hex 1..8 car.): {can_id!r}")
    return can_id.strip().upper()


def _validate_hex_data(data, field_name: str) -> str:
    if data is None:
        data = ""
    if not isinstance(data, str):
        raise ValueError(f"{field_name} invalide: {data!r}")
    data = data.strip()
    if not _HEX_DATA_RE.match(data):
        raise ValueError(f"{field_name} invalide (hex pair, 0..8 octets): {data!r}")
    return data.upper()


def _validate_severity(severity) -> str:
    if severity is None:
        return DEFAULT_SEVERITY
    if severity not in SEVERITIES:
        raise ValueError(f"severity invalide (info|warning|danger): {severity!r}")
    return severity


def _validate_label(label) -> str:
    if not isinstance(label, str) or not label.strip():
        raise ValueError("label requis (chaine non vide)")
    return label.strip()


def _validate_notes(notes) -> str:
    notes = notes or ""
    if not isinstance(notes, str):
        raise ValueError(f"notes invalide: {notes!r}")
    return notes


def load_frames() -> list:
    """Charge la bibliotheque de trames connues. Defaut : liste vide (fichier absent
    ou illisible) - la lecture ne doit jamais planter l'appelant."""
    try:
        with open(KNOWN_FRAMES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        frames = data.get("frames", []) if isinstance(data, dict) else []
        return [f for f in frames if isinstance(f, dict)]
    except FileNotFoundError:
        return []
    except (ValueError, OSError):
        return []


def save_frames(frames: list) -> None:
    """Sauvegarde atomique : fichier temporaire, flush + fsync, puis os.replace."""
    path = Path(KNOWN_FRAMES_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"frames": frames}, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def add_frame(data: dict) -> dict:
    """Ajoute une trame connue. `id` (uuid4 hex) et `created_at` (ISO UTC) sont
    generes ici. Leve ValueError sur hex/label/severity invalides (-> 400 cote API)."""
    frame = {
        "id": uuid4().hex,
        "can_id": _validate_hex_id(data.get("can_id", "")),
        "crash_data": _validate_hex_data(data.get("crash_data", ""), "crash_data"),
        "reset_data": _validate_hex_data(data.get("reset_data", ""), "reset_data"),
        "label": _validate_label(data.get("label")),
        "severity": _validate_severity(data.get("severity")),
        "notes": _validate_notes(data.get("notes")),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    frames = load_frames()
    frames.append(frame)
    save_frames(frames)
    return frame


def update_frame(fid: str, patch: dict):
    """Fusionne `patch` dans la trame `fid`. Retourne la trame mise a jour, ou None
    si `fid` est introuvable. Leve ValueError sur un champ invalide (-> 400 cote API)."""
    frames = load_frames()
    for i, existing in enumerate(frames):
        if existing.get("id") != fid:
            continue
        updated = dict(existing)
        if "can_id" in patch:
            updated["can_id"] = _validate_hex_id(patch["can_id"])
        if "crash_data" in patch:
            updated["crash_data"] = _validate_hex_data(patch["crash_data"], "crash_data")
        if "reset_data" in patch:
            updated["reset_data"] = _validate_hex_data(patch["reset_data"], "reset_data")
        if "label" in patch:
            updated["label"] = _validate_label(patch["label"])
        if "severity" in patch:
            updated["severity"] = _validate_severity(patch["severity"])
        if "notes" in patch:
            updated["notes"] = _validate_notes(patch["notes"])
        frames[i] = updated
        save_frames(frames)
        return updated
    return None


def delete_frame(fid: str) -> bool:
    """Retire la trame `fid`. Retourne False si elle n'existait pas (-> 404 cote API)."""
    frames = load_frames()
    remaining = [f for f in frames if f.get("id") != fid]
    if len(remaining) == len(frames):
        return False
    save_frames(remaining)
    return True


def get_frame(fid: str):
    """Lecture simple d'une trame par id (None si absente)."""
    for f in load_frames():
        if f.get("id") == fid:
            return f
    return None
