"""Fixtures communes : rend les modules du backend importables (imports à plat)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


@pytest.fixture(autouse=True)
def _fresh_main_routers():
    """Les tests reimportent `main` (sys.modules.pop). Les routers extraits font
    `import main` : on les purge aussi pour qu'ils se rebindent sur le `main` frais
    (sinon ils pointeraient vers un module `main` perime, avec un autre `state`)."""
    for name in [m for m in sys.modules if m.startswith("routers.") and m != "routers.users"]:
        sys.modules.pop(name, None)
    yield
