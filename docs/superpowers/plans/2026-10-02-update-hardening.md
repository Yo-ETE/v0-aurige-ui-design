# Update Hardening Implementation Plan (Lot 3, safe subset)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the branch-name ref/argument-injection in `/api/system/update`, remove the duplicate `restart-services` route, fix the lifespan `Process.wait(timeout)` TypeError, and change the hardcoded default branch to `main` — WITHOUT altering the update happy-path (the deploy mechanism).

**Architecture:** New `backend/validators.py::valid_git_ref` gates the only user input to the update flow (the branch name); three targeted edits in `backend/main.py` plus one in `scripts/update_pi.sh`. All unit/TestClient-testable; the clone+install happy-path is untouched.

**Tech Stack:** Python/FastAPI; pytest + Starlette TestClient.

**Spec:** `docs/superpowers/specs/2026-10-02-update-hardening-design.md`

## Global Constraints

- FLAT imports (`from validators import valid_git_ref`).
- Do NOT change the update happy-path (rm -rf repo + git clone + install_pi.sh). Only ADD a validation guard at the handler start and change fallback-branch literals.
- Commands stay list-form, never shell=True.
- `valid_git_ref`: str, len 1..200, `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, no `..`, no `//`.
- Comments/UI French, code English.

## File Structure

- Create: `backend/validators.py`, `backend/tests/test_validators.py`, `backend/tests/test_update_guard.py`.
- Modify: `backend/main.py`, `scripts/update_pi.sh`.

---

### Task 1: valid_git_ref validator + guard the update endpoint

**Files:** Create `backend/validators.py`, `backend/tests/test_validators.py`, `backend/tests/test_update_guard.py`. Modify `backend/main.py` (import + guard only).

**Interfaces:** Produces `def valid_git_ref(ref: str) -> bool`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_validators.py
import validators

def test_valid_git_ref_accepts():
    for r in ["main", "audit-remediation", "feature/x_1.2", "v0/yo-ete-5c91d9cb", "release/1.0.0"]:
        assert validators.valid_git_ref(r), r

def test_valid_git_ref_rejects():
    for r in ["", "-rm", "-rf", "a..b", "a b", "a;b", "a$b", "a//b", "/lead", "x"*201]:
        assert not validators.valid_git_ref(r), r
    assert not validators.valid_git_ref(None)  # type: ignore
    assert not validators.valid_git_ref(123)   # type: ignore
```

```python
# backend/tests/test_update_guard.py
import pytest
from starlette.testclient import TestClient
import db, auth, main

@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "t.db"))
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
    # neutralize the background update task + branch.txt write so no clone happens
    monkeypatch.setattr(main, "run_update", lambda *a, **k: None, raising=False)
    c = TestClient(auth.SessionAuthMiddleware(main.fastapi_app))
    auth._login_attempts.clear()
    c.post("/api/auth/login", json={"username": "admin", "password": pw})
    yield c
    await db.close_db()

def test_update_rejects_bad_branch(client):
    r = client.post("/api/system/update", json={"branch": "-rm"})
    assert r.status_code == 400

def test_update_accepts_good_branch(client):
    r = client.post("/api/system/update", json={"branch": "main"})
    assert r.status_code != 400  # accepted (200/202 per current contract)

def test_single_restart_services_route():
    paths = [r.path for r in main.fastapi_app.routes if getattr(r, "path", "") == "/api/system/restart-services"]
    assert len(paths) == 1
```
(If `run_update`/the update task name differs, adapt the monkeypatch to neutralize whatever the handler schedules — the goal is that a 400 happens before any clone, and a good branch doesn't actually clone during the test. If the handler body makes mocking hard, at minimum assert the 400 path returns before `update_output_store["running"]` is set.)

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && python -m pytest tests/test_validators.py tests/test_update_guard.py -v` → FAIL (module + guard missing; dup route still present).

- [ ] **Step 3: Implement**

`backend/validators.py`:
```python
"""AURIGE - Validateurs d'entrées (sûreté shell / git)."""
import re

_GIT_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


def valid_git_ref(ref) -> bool:
    if not isinstance(ref, str):
        return False
    if not (1 <= len(ref) <= 200):
        return False
    if ".." in ref or "//" in ref:
        return False
    return bool(_GIT_REF.match(ref))
```

`backend/main.py`: add `from validators import valid_git_ref` near the flat imports. In the `POST /api/system/update` handler, at the very start (before reading/writing branch.txt or scheduling the task):
```python
    if isinstance(body, dict) and body.get("branch") is not None:
        if not valid_git_ref(str(body["branch"])):
            raise HTTPException(status_code=400, detail="Branche invalide")
```
(Match the handler's actual body access — it reads `body["branch"]`; keep that read but guard first. Do not change anything downstream.)

Also in this task, remove the DEAD duplicate `@app.post("/api/system/restart-services")` at ~line 6680 and its function body (keep the live one at ~5224). Confirm by grep that exactly one remains.

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && python -m pytest tests/test_validators.py tests/test_update_guard.py -v` → PASS. Then `cd backend && python -m pytest tests/ -v` → whole suite green.

- [ ] **Step 5: Commit**

```bash
git add backend/validators.py backend/tests/test_validators.py backend/tests/test_update_guard.py backend/main.py
git commit -m "fix(system): validate update branch (ref/arg-injection), drop duplicate restart-services route"
```

---

### Task 2: Fix Process.wait TypeError + default branch → main

**Files:** Modify `backend/main.py`, `scripts/update_pi.sh`.

- [ ] **Step 1: Fix the lifespan Process.wait (main.py ~line 96)**

Change `proc.wait(timeout=2.0)` to `await asyncio.wait_for(proc.wait(), timeout=2.0)` inside the lifespan shutdown loop (lines ~91-98). Confirm the loop is in the async lifespan (it is) and mirror the existing correct usage at line ~1131 (`await asyncio.wait_for(proc.wait(), timeout=1.0)`), keeping the surrounding `terminate()`/`except → kill()` structure:
```python
    for proc in [state.candump_process, state.capture_process, state.canplayer_process, state.cangen_process]:
        if proc:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except Exception:
                proc.kill()
```
(Use the exact proc list already present at lines 91-93; only the wait call changes.)

- [ ] **Step 2: Default branch → main**

In `backend/main.py` replace the fallback literals `"v0/yo-ete-5c91d9cb"` with `"main"` at the occurrences that are branch FALLBACKS (lines ~4759, ~4781, ~5026, ~5044). Do not touch any string that is not a default-branch fallback. In `scripts/update_pi.sh` line 20: `TARGET_BRANCH="v0/yo-ete-5c91d9cb"` → `TARGET_BRANCH="main"`.

- [ ] **Step 3: Verify**

Run: `cd backend && python -m pytest tests/ -v` → whole suite green (nothing should regress; the default-branch change only affects the fallback when branch.txt is empty and no branch is passed). `grep -n "v0/yo-ete-5c91d9cb" backend/main.py scripts/update_pi.sh` → no matches. `bash -n scripts/update_pi.sh` → ok. Read the lifespan diff to confirm the await fix compiles (it's in an async function).

- [ ] **Step 4: Commit**

```bash
git add backend/main.py scripts/update_pi.sh
git commit -m "fix(system): await Process.wait in lifespan shutdown, default branch main"
```

---

## Self-Review

**Spec coverage:** §1.1 branch validation → Task 1; §1.2 dup restart-services → Task 1; §1.3 Process.wait → Task 2; §1.4 default main → Task 2. All covered.

**Placeholder scan:** the update-guard test notes a concrete fallback if `run_update` can't be mocked (assert 400 before `update_output_store["running"]`), not a vague TODO. Validator + guard code are concrete.

**Consistency:** `valid_git_ref` signature identical in validator, tests, and the main.py guard. The Process.wait fix mirrors the existing line-1131 idiom. The default-branch change is fallback-only; branch.txt + an explicit `body["branch"]` still win, so the deploy flow (branch.txt=audit-remediation) is unaffected.

**Risk:** the happy-path of `/api/system/update` is untouched (only a 400 guard added before it). The default-branch literal change affects only the no-branch-txt/no-body fallback. No live-Pi behavior of a normal update changes.
