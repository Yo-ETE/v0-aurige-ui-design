"""AURIGE - Permissions fines (RBAC). Voir la spec pour la matrice complète."""
import re

AREA_FLAGS = [
    "area_dashboard", "area_missions", "area_control", "area_analysis",
    "area_capture", "area_configuration", "area_administration",
]
ACTION_FLAGS = [
    "can_inject", "fuzzing_run", "crash_recovery_run", "causality_validate",
    "capture_run", "replay_run", "missions_create", "missions_edit",
    "missions_delete", "dbc_manage", "obd_write", "system_update",
    "system_reboot", "system_network", "system_backup",
]
ALL_FLAGS = AREA_FLAGS + ACTION_FLAGS

VIEWER_DEFAULT = {f: False for f in ALL_FLAGS}
VIEWER_DEFAULT.update({
    "area_dashboard": True, "area_missions": True,
    "area_analysis": True, "area_capture": True,
})

OPERATOR_DEFAULT = {f: True for f in ALL_FLAGS}
OPERATOR_DEFAULT.update({
    "area_administration": False, "system_update": False,
    "system_reboot": False, "system_network": False, "system_backup": False,
})

PRESETS = {"admin": None, "operator": OPERATOR_DEFAULT, "viewer": VIEWER_DEFAULT}
DEFAULT_PERMISSIONS = VIEWER_DEFAULT


def sanitize_permissions(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None
    return {k: v for k, v in raw.items() if k in ALL_FLAGS and isinstance(v, bool)}


def effective_permissions(role, permissions):
    if role == "admin":
        return {f: True for f in ALL_FLAGS}
    eff = dict(VIEWER_DEFAULT)
    if permissions:
        eff.update({k: bool(v) for k, v in permissions.items() if k in ALL_FLAGS})
    return eff


def allows(role, permissions, needed):
    eff = effective_permissions(role, permissions)
    return any(eff.get(f, False) for f in needed)


# (method, compiled regex on path) -> required flags (any-of). Fail-closed:
# add an entry for every injection/stateful/system route. Starter set covers
# the dangerous routes; extend by auditing main.py (see Task 5, Step 6).
_ROUTE_RULES = [
    # --- Injection de trames / pilotage du bus ---
    ("POST", r"^/api/can/send", ["can_inject"]),
    ("POST", r"^/api/can/(init|stop|scan-bitrate)", ["can_inject"]),
    ("POST", r"^/api/generator/", ["can_inject"]),
    ("POST", r"^/api/fuzzing/(start|run|stop|force-cleanup)", ["fuzzing_run"]),
    ("POST", r"^/api/fuzzing/crash-recovery", ["crash_recovery_run"]),
    ("POST", r"^/api/analysis/validate-causality", ["causality_validate"]),
    ("POST", r"^/api/capture/", ["capture_run"]),
    ("POST", r"^/api/replay/", ["replay_run"]),
    # --- OBD (ecriture : effacement DTC, reset ECU) ---
    ("POST", r"^/api/obd/(reset|dtc/clear)", ["obd_write"]),
    # --- DBC (avant les regles missions : premier match gagne) ---
    ("POST", r"^/api/missions/[^/]+/dbc", ["dbc_manage"]),
    ("PUT", r"^/api/missions/[^/]+/dbc", ["dbc_manage"]),
    ("PATCH", r"^/api/missions/[^/]+/dbc", ["dbc_manage"]),
    ("DELETE", r"^/api/missions/[^/]+/dbc", ["dbc_manage"]),
    # --- Missions ---
    ("POST", r"^/api/missions$", ["missions_create"]),
    ("POST", r"^/api/missions/[^/]+/duplicate$", ["missions_create"]),
    ("DELETE", r"^/api/missions/[^/]+$", ["missions_delete"]),
    ("PATCH", r"^/api/missions/[^/]+$", ["missions_edit"]),
    ("PUT", r"^/api/missions/[^/]+$", ["missions_edit"]),
    ("POST", r"^/api/missions/[^/]+/(logs/(create-frame|[^/]+/(rename|split))|import-log|comparisons)", ["missions_edit"]),
    ("PUT", r"^/api/missions/[^/]+/", ["missions_edit"]),
    ("PATCH", r"^/api/missions/[^/]+/", ["missions_edit"]),
    ("DELETE", r"^/api/missions/[^/]+/", ["missions_edit"]),
    # --- Systeme / reseau ---
    ("POST", r"^/api/system/(apt|update)", ["system_update"]),
    ("POST", r"^/api/system/(reboot|shutdown|restart-services)", ["system_reboot"]),
    ("POST", r"^/api/system/backups?", ["system_backup"]),
    ("POST", r"^/api/network/", ["system_network"]),
    ("POST", r"^/api/tailscale/", ["system_network"]),
    # Verbes non-POST : fail-closed sur les memes prefixes
    ("PUT", r"^/api/system/(apt|update)", ["system_update"]),
    ("PATCH", r"^/api/system/(apt|update)", ["system_update"]),
    ("DELETE", r"^/api/system/(apt|update)", ["system_update"]),
    ("PUT", r"^/api/system/(reboot|shutdown|restart-services)", ["system_reboot"]),
    ("PATCH", r"^/api/system/(reboot|shutdown|restart-services)", ["system_reboot"]),
    ("DELETE", r"^/api/system/(reboot|shutdown|restart-services)", ["system_reboot"]),
    ("PUT", r"^/api/system/backups?", ["system_backup"]),
    ("PATCH", r"^/api/system/backups?", ["system_backup"]),
    ("DELETE", r"^/api/system/backups?", ["system_backup"]),
    ("PUT", r"^/api/network/", ["system_network"]),
    ("PATCH", r"^/api/network/", ["system_network"]),
    ("DELETE", r"^/api/network/", ["system_network"]),
    ("PUT", r"^/api/tailscale/", ["system_network"]),
    ("PATCH", r"^/api/tailscale/", ["system_network"]),
    ("DELETE", r"^/api/tailscale/", ["system_network"]),
    # Fail-closed : tout autre verbe mutant sous /api/system/ exige system_update
    ("PUT", r"^/api/system/", ["system_update"]),
    ("PATCH", r"^/api/system/", ["system_update"]),
    ("DELETE", r"^/api/system/", ["system_update"]),
]
_COMPILED = [(m, re.compile(p), flags) for m, p, flags in _ROUTE_RULES]


def required_permissions(method, path):
    for m, rx, flags in _COMPILED:
        if m == method and rx.search(path):
            return flags
    return []


def is_admin_route(method, path):
    if re.match(r"^/api/auth/users(/[^/]+)?$", path) and method in ("POST", "PATCH", "DELETE"):
        return True
    return False
