import permissions as perms


def test_admin_has_everything():
    eff = perms.effective_permissions("admin", None)
    assert all(eff[f] for f in perms.ALL_FLAGS)


def test_viewer_default_read_only():
    eff = perms.effective_permissions("viewer", None)
    assert eff["area_dashboard"] and eff["area_missions"]
    assert not eff["can_inject"] and not eff["area_administration"]


def test_operator_can_inject_not_system():
    eff = perms.effective_permissions("viewer", perms.OPERATOR_DEFAULT)
    assert eff["can_inject"] and eff["missions_create"]
    assert not eff["system_reboot"] and not eff["area_administration"]


def test_allows_any_of():
    assert perms.allows("viewer", perms.OPERATOR_DEFAULT, ["can_inject"])
    assert not perms.allows("viewer", None, ["can_inject"])
    assert perms.allows("admin", None, ["system_reboot"])


def test_required_permissions_matches_dangerous_routes():
    assert perms.required_permissions("POST", "/api/can/send") == ["can_inject"]
    assert perms.required_permissions("POST", "/api/fuzzing/start") == ["fuzzing_run"]
    assert perms.required_permissions("GET", "/api/missions") == []


def test_is_admin_route():
    assert perms.is_admin_route("POST", "/api/auth/users")
    assert perms.is_admin_route("DELETE", "/api/auth/users/3")
    assert not perms.is_admin_route("GET", "/api/missions")


def test_sanitize_drops_unknown_keys():
    out = perms.sanitize_permissions({"can_inject": True, "bogus": True})
    assert out == {"can_inject": True}
