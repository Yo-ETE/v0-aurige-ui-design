import os
import pytest
from pathlib import Path
import db

@pytest.fixture
async def store(tmp_path):
    await db.init_db(tmp_path / "test.db")
    yield db
    await db.close_db()

def test_hash_roundtrip():
    h = db.hash_password("correct horse battery")
    assert "$" in h
    assert db.verify_password("correct horse battery", h)
    assert not db.verify_password("wrong", h)

def test_verify_rejects_malformed():
    assert not db.verify_password("x", "no-dollar-sign")

@pytest.mark.asyncio
async def test_create_and_fetch_user(store):
    uid = await store.create_user("alice", "password-123", role="viewer",
                                  permissions={"area_dashboard": True})
    u = await store.get_user_by_username("alice")
    assert u["id"] == uid and u["role"] == "viewer"
    assert u["permissions"] == {"area_dashboard": True}
    assert u["is_active"] is True
    assert (await store.get_user_by_id(uid))["username"] == "alice"
    stored = await db._get_password_hash("alice")
    assert db.verify_password("password-123", stored) is True
    assert db.verify_password("wrong-password", stored) is False

@pytest.mark.asyncio
async def test_update_and_delete_user(store):
    uid = await store.create_user("bob", "password-123")
    await store.update_user(uid, role="admin", is_active=False)
    u = await store.get_user_by_id(uid)
    assert u["role"] == "admin" and u["is_active"] is False
    await store.delete_user(uid)
    assert await store.get_user_by_id(uid) is None

@pytest.mark.asyncio
async def test_seed_admin_creates_one_admin(store, tmp_path):
    # init_db already seeded because users was empty
    assert await store.count_admins() == 1
    assert (tmp_path / "initial_admin_password.txt").exists()

@pytest.mark.asyncio
async def test_session_lifecycle(store):
    uid = await store.create_user("carol", "password-123")
    tok = await store.create_session(uid)
    s = await store.get_session_user(tok)
    assert s["id"] == uid and s["token"] == tok
    await store.delete_session(tok)
    store.invalidate_user_cache(uid)
    assert await store.get_session_user(tok) is None

@pytest.mark.asyncio
async def test_expired_session_rejected(store):
    uid = await store.create_user("dave", "password-123")
    tok = await store.create_session(uid, ttl_seconds=-1)
    store.invalidate_user_cache(uid)
    assert await store.get_session_user(tok) is None

def test_verify_rejects_garbage():
    assert not db.verify_password("x", None)
    assert not db.verify_password("x", 123)

@pytest.mark.asyncio
async def test_inactive_user_session_rejected(store):
    uid = await store.create_user("erin", "password-123")
    tok = await store.create_session(uid)
    await store.update_user(uid, is_active=False)
    assert await store.get_session_user(tok) is None

@pytest.mark.asyncio
async def test_update_permissions_sentinel(store):
    uid = await store.create_user("frank", "password-123", permissions={"a": True})
    await store.update_user(uid, role="admin")
    assert (await store.get_user_by_id(uid))["permissions"] == {"a": True}
    await store.update_user(uid, permissions=None)
    assert (await store.get_user_by_id(uid))["permissions"] is None
    await store.update_user(uid, permissions={"b": False})
    assert (await store.get_user_by_id(uid))["permissions"] == {"b": False}

async def _count_sessions(store, uid):
    cur = await store._conn.execute(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", (uid,))
    return (await cur.fetchone())["n"]

@pytest.mark.asyncio
async def test_delete_user_cascades_sessions(store):
    uid = await store.create_user("gina", "password-123")
    await store.create_session(uid)
    assert await _count_sessions(store, uid) == 1
    await store.delete_user(uid)
    assert await _count_sessions(store, uid) == 0

@pytest.mark.asyncio
async def test_delete_user_sessions(store):
    uid = await store.create_user("hank", "password-123")
    await store.create_session(uid)
    await store.create_session(uid)
    assert await _count_sessions(store, uid) == 2
    await store.delete_user_sessions(uid)
    assert await _count_sessions(store, uid) == 0

@pytest.mark.asyncio
async def test_cleanup_expired_sessions(store):
    uid = await store.create_user("ivy", "password-123")
    await store.create_session(uid, ttl_seconds=-10)
    keep = await store.create_session(uid)
    await store.cleanup_expired_sessions()
    assert await _count_sessions(store, uid) == 1
    assert (await store.get_session_user(keep))["id"] == uid

@pytest.mark.asyncio
async def test_session_cache_and_invalidation(store):
    uid = await store.create_user("jack", "password-123")
    tok = await store.create_session(uid)
    first = await store.get_session_user(tok)
    assert await store.get_session_user(tok) is first  # cache hit
    store.invalidate_user_cache(uid)
    again = await store.get_session_user(tok)
    assert again is not first and again["id"] == uid

@pytest.mark.asyncio
async def test_seed_idempotent(store, tmp_path):
    pw_file = tmp_path / "initial_admin_password.txt"
    before = pw_file.read_text(encoding="utf-8")
    await store.close_db()
    await store.init_db(tmp_path / "test.db")
    assert await store.count_admins() == 1
    assert len(await store.list_users()) == 1
    assert pw_file.read_text(encoding="utf-8") == before

@pytest.mark.asyncio
async def test_initial_password_file_mode(store, tmp_path):
    path = tmp_path / "initial_admin_password.txt"
    assert path.exists()
    if os.name == "posix":
        assert oct(path.stat().st_mode & 0o777) == "0o600"
