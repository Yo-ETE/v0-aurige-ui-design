"""
Fixtures communes : main.py a des effets de bord à l'import (création de
DATA_DIR, lecture du token), donc l'environnement est fixé avant l'import.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

TEST_TOKEN = "test-token-aurige"

_tmp = Path(tempfile.mkdtemp(prefix="aurige-tests-"))
os.environ["AURIGE_DATA_DIR"] = str(_tmp / "data")
os.environ["AURIGE_TOKEN_FILE"] = str(_tmp / "api_token")
os.environ["AURIGE_API_TOKEN"] = TEST_TOKEN

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(scope="session")
def app():
    import main
    return main.app


@pytest.fixture
def client(app):
    from fastapi.testclient import TestClient
    return TestClient(app)
