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
    assert not db.verify_password("password-123", "") and \
        (await store.get_user_by_id(uid))["username"] == "alice"

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
