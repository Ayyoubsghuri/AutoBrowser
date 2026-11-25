import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["AUTOBROWSER_DATA"] = _tmp
os.environ["AUTOBROWSER_TOKEN"] = "test-token"

import pytest
from fastapi.testclient import TestClient

from app import db, vault


@pytest.fixture()
def client():
    db.connect(os.path.join(_tmp, f"t{os.urandom(4).hex()}.db"))
    vault.reset_for_tests()
    from app.main import app
    c = TestClient(app)
    c.headers["x-autobrowser-token"] = "test-token"
    return c
