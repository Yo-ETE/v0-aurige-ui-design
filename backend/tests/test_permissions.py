import permissions as perms


# ============================================================================
# Flag Invariants & Preset Matrix (CRITICAL: any flag change is a vuln)
# ============================================================================

def test_all_flags_count_and_uniqueness():
    """Verify flag list integrity: 22 total, no duplicates, proper union."""
    assert len(perms.ALL_FLAGS) == 22
    assert len(set(perms.ALL_FLAGS)) == 22  # no duplicates
    assert set(perms.ALL_FLAGS) == set(perms.AREA_FLAGS) | set(perms.ACTION_FLAGS)
    assert len(perms.AREA_FLAGS) == 7
    assert len(perms.ACTION_FLAGS) == 15  # 7 + 15 = 22


def test_admin_has_everything():
    """Admin role has all 22 flags True."""
    eff = perms.effective_permissions("admin", None)
    assert len(eff) == 22
    assert all(eff[f] for f in perms.ALL_FLAGS)


def test_viewer_default_exact_matrix():
    """Viewer role has EXACTLY: area_dashboard, area_missions, area_analysis, area_capture True; rest False."""
    eff = perms.effective_permissions("viewer", None)
    viewer_true_flags = {"area_dashboard", "area_missions", "area_analysis", "area_capture"}
    assert set(k for k, v in eff.items() if v) == viewer_true_flags
    assert all(not eff[f] for f in set(perms.ALL_FLAGS) - viewer_true_flags)


def test_operator_default_exact_matrix():
    """Operator (via permission dict on viewer) has EXACTLY: area_administration, system_update, system_reboot, system_network, system_backup False; rest True."""
    eff = perms.effective_permissions("viewer", perms.OPERATOR_DEFAULT)
    operator_false_flags = {"area_administration", "system_update", "system_reboot", "system_network", "system_backup"}
    assert set(k for k, v in eff.items() if not v) == operator_false_flags
    assert all(eff[f] for f in set(perms.ALL_FLAGS) - operator_false_flags)


def test_default_permissions_is_viewer_default():
    """DEFAULT_PERMISSIONS must equal VIEWER_DEFAULT (invariant)."""
    assert perms.DEFAULT_PERMISSIONS == perms.VIEWER_DEFAULT


# ============================================================================
# Permission Overlay & Composition
# ============================================================================

def test_viewer_overlay_with_injection():
    """Viewer + inject override: can_inject becomes True, area_dashboard remains True."""
    eff = perms.effective_permissions("viewer", {"can_inject": True})
    assert eff["can_inject"] is True
    assert eff["area_dashboard"] is True
    assert eff["system_reboot"] is False  # not in overlay, viewer default applies


def test_allows_empty_needed_list():
    """allows() with empty needed list returns False; callers must guard with `if needed:`."""
    # Auth-only routes pass [] as needed; should reject unless role is admin.
    assert perms.allows("viewer", None, []) is False
    assert perms.allows("admin", None, []) is False  # even admin returns False on empty


def test_allows_any_of():
    """allows() checks ANY-OF logic on flag list."""
    assert perms.allows("viewer", perms.OPERATOR_DEFAULT, ["can_inject"])
    assert not perms.allows("viewer", None, ["can_inject"])
    assert perms.allows("admin", None, ["system_reboot"])


# ============================================================================
# Strict Boolean Sanitization (SECURITY: prevent privilege escalation)
# ============================================================================

def test_sanitize_strict_bool_rejects_string_false():
    """String "false" is truthy in Python; sanitize must reject non-bool values."""
    out = perms.sanitize_permissions({"can_inject": "false"})
    assert "can_inject" not in out
    assert out == {}


def test_sanitize_strict_bool_rejects_string_true():
    """String "true" must be rejected; only bool True is valid."""
    out = perms.sanitize_permissions({"can_inject": "true"})
    assert "can_inject" not in out
    assert out == {}


def test_sanitize_strict_bool_rejects_int():
    """Integer values (0, 1) must be rejected; only bool True/False valid."""
    out = perms.sanitize_permissions({"can_inject": 1, "area_dashboard": 0})
    assert out == {}


def test_sanitize_accepts_none_input():
    """sanitize_permissions(None) → None."""
    assert perms.sanitize_permissions(None) is None


def test_sanitize_rejects_non_dict_input():
    """Non-dict, non-None input (string, list, int) → None."""
    assert perms.sanitize_permissions("garbage") is None
    assert perms.sanitize_permissions([]) is None
    assert perms.sanitize_permissions(123) is None


def test_sanitize_valid_bool_dict():
    """Valid bool dict passes through; unknown keys dropped."""
    out = perms.sanitize_permissions({"can_inject": True, "bogus": True})
    assert out == {"can_inject": True}
    out = perms.sanitize_permissions({"area_dashboard": False, "missions_delete": True, "unknown": False})
    assert out == {"area_dashboard": False, "missions_delete": True}


# ============================================================================
# Route Permission Matching
# ============================================================================

def test_required_permissions_matches_dangerous_routes():
    """Route matcher correctly identifies dangerous endpoints."""
    # CAN injection
    assert perms.required_permissions("POST", "/api/can/send") == ["can_inject"]

    # Fuzzing
    assert perms.required_permissions("POST", "/api/fuzzing/start") == ["fuzzing_run"]
    assert perms.required_permissions("POST", "/api/fuzzing/crash-recovery") == ["crash_recovery_run"]

    # Analysis
    assert perms.required_permissions("POST", "/api/analysis/validate-causality") == ["causality_validate"]

    # Capture & Replay
    assert perms.required_permissions("POST", "/api/capture/start") == ["capture_run"]
    assert perms.required_permissions("POST", "/api/replay/start") == ["replay_run"]

    # Missions
    assert perms.required_permissions("DELETE", "/api/missions/5") == ["missions_delete"]

    # System
    assert perms.required_permissions("POST", "/api/system/reboot") == ["system_reboot"]
    assert perms.required_permissions("POST", "/api/network/") == ["system_network"]


def test_required_permissions_wrong_method_returns_empty():
    """Wrong HTTP method on route returns [] (no permission required)."""
    assert perms.required_permissions("GET", "/api/can/send") == []
    assert perms.required_permissions("DELETE", "/api/can/send") == []


def test_required_permissions_unknown_route_returns_empty():
    """Unknown route returns [] (no permission required)."""
    assert perms.required_permissions("GET", "/api/missions") == []
    assert perms.required_permissions("POST", "/api/unknown/path") == []


# ============================================================================
# Admin Route Detection
# ============================================================================

def test_is_admin_route():
    """Admin route detector recognizes /api/auth/users/* with POST/PATCH/DELETE."""
    assert perms.is_admin_route("POST", "/api/auth/users")
    assert perms.is_admin_route("PATCH", "/api/auth/users/3")
    assert perms.is_admin_route("DELETE", "/api/auth/users/3")
    assert not perms.is_admin_route("GET", "/api/missions")
    assert not perms.is_admin_route("GET", "/api/auth/users")  # GET not admin
    assert not perms.is_admin_route("POST", "/api/auth/sessions")  # wrong path


def test_route_audit_new_rules():
    """Task 5 route audit: every dangerous/stateful route has a guard."""
    rp = perms.required_permissions
    # OBD write
    assert rp("POST", "/api/obd/reset") == ["obd_write"]
    assert rp("POST", "/api/obd/dtc/clear") == ["obd_write"]
    assert rp("POST", "/api/obd/dtc/read") == []  # lecture seule
    # DBC
    assert rp("POST", "/api/missions/m1/dbc/import") == ["dbc_manage"]
    assert rp("POST", "/api/missions/m1/dbc/signal") == ["dbc_manage"]
    assert rp("DELETE", "/api/missions/m1/dbc/signal/s1") == ["dbc_manage"]
    assert rp("DELETE", "/api/missions/m1/dbc/message/123") == ["dbc_manage"]
    assert rp("DELETE", "/api/missions/m1/dbc") == ["dbc_manage"]
    # Generator start/stop (no "send" in path)
    assert rp("POST", "/api/generator/start") == ["can_inject"]
    assert rp("POST", "/api/generator/stop") == ["can_inject"]
    # CAN bus control
    for p in ("init", "stop", "scan-bitrate"):
        assert rp("POST", f"/api/can/{p}") == ["can_inject"]
    # Fuzzing stop/cleanup
    assert rp("POST", "/api/fuzzing/stop") == ["fuzzing_run"]
    assert rp("POST", "/api/fuzzing/force-cleanup") == ["fuzzing_run"]
    # Missions edit/create
    assert rp("PATCH", "/api/missions/m1") == ["missions_edit"]
    assert rp("POST", "/api/missions/m1/duplicate") == ["missions_create"]
    assert rp("DELETE", "/api/missions/m1/logs/l1") == ["missions_edit"]
    assert rp("PUT", "/api/missions/m1/logs/l1/tags") == ["missions_edit"]
    assert rp("POST", "/api/missions/m1/logs/l1/rename") == ["missions_edit"]
    assert rp("POST", "/api/missions/m1/logs/l1/split") == ["missions_edit"]
    assert rp("POST", "/api/missions/m1/logs/create-frame") == ["missions_edit"]
    assert rp("POST", "/api/missions/m1/import-log") == ["missions_edit"]
    assert rp("POST", "/api/missions/m1/comparisons") == ["missions_edit"]
    assert rp("DELETE", "/api/missions/m1/comparisons/c1") == ["missions_edit"]
    # Read-only analysis POSTs stay open
    assert rp("POST", "/api/missions/m1/compare-logs") == []
    assert rp("POST", "/api/missions/m1/logs/l1/co-occurrence") == []
    # System: shutdown + singular backup were previously uncovered
    assert rp("POST", "/api/system/shutdown") == ["system_reboot"]
    assert rp("POST", "/api/system/backup") == ["system_backup"]
    assert rp("POST", "/api/system/backups/f.tar/restore") == ["system_backup"]
    assert rp("DELETE", "/api/system/backups/f.tar") == ["system_backup"]
    # Non-POST verbs on system/network/tailscale
    assert rp("PUT", "/api/network/wifi/connect") == ["system_network"]
    assert rp("DELETE", "/api/network/wifi/saved") == ["system_network"]
    assert rp("PUT", "/api/tailscale/up") == ["system_network"]
    assert rp("DELETE", "/api/tailscale/x") == ["system_network"]
    assert rp("PUT", "/api/system/reboot") == ["system_reboot"]
    assert rp("PATCH", "/api/system/update") == ["system_update"]
    assert rp("DELETE", "/api/system/anything") == ["system_update"]
    # GETs never gated
    assert rp("GET", "/api/system/backups") == []
