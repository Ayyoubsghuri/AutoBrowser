import json
from types import SimpleNamespace

import pyotp

from app import ai


def test_token_required(client):
    assert client.get("/flows", headers={"x-autobrowser-token": "nope"}).status_code == 401
    assert client.get("/health", headers={"x-autobrowser-token": ""}).status_code == 200


def test_profiles_and_secrets(client):
    p = client.post("/profiles", json={"name": "Shop account 1"}).json()
    assert p["partition"] == f"persist:ab_{p['id']}"
    secret = pyotp.random_base32()
    c = client.post("/credentials", json={"profile_id": p["id"], "site": "shop.example.com", "username": "me@x.com",
                                          "password": "hunter2", "totp_secret": secret}).json()
    assert c["has_password"] and c["has_totp"] and "password" not in c
    s = client.get(f"/profiles/{p['id']}/secrets", params={"site": "https://shop.example.com/login"}).json()
    assert s["username"] == "me@x.com" and s["password"] == "hunter2" and len(s["totp"]) == 6
    client.patch(f"/credentials/{c['id']}", json={"password": "new"})
    assert client.get(f"/profiles/{p['id']}/secrets").json()["password"] == "new"
    # passwords are encrypted at rest
    from app import db
    raw = db.connect().execute("SELECT password_enc FROM credentials").fetchone()[0]
    assert "new" not in raw


def test_flow_crud_and_runs_csv(client):
    f = client.post("/flows", json={"name": "Export orders", "start_url": "https://x.test",
                                    "steps": [{"id": "s1", "type": "click", "tip": ""}]}).json()
    f2 = client.patch(f"/flows/{f['id']}", json={"name": "Orders"}).json()
    assert f2["name"] == "Orders" and f2["steps"][0]["id"] == "s1"
    r = client.post("/runs", json={"flow_id": f["id"]}).json()
    client.patch(f"/runs/{r['id']}", json={"log": [{"msg": "hi"}], "output": [{"name": "orders", "data": [{"id": 1, "total": "9.99"}, {"id": 2, "total": "5"}]}], "status": "success", "finished": True})
    run = client.get(f"/runs/{r['id']}").json()
    assert run["status"] == "success" and run["finished"]
    csv = client.get(f"/runs/{r['id']}/output.csv").text.splitlines()
    assert csv[0] == "id,total" and len(csv) == 3


def test_compile_without_key(client):
    f = client.post("/flows", json={"name": "x"}).json()
    r = client.post(f"/flows/{f['id']}/compile")
    assert r.status_code == 400 and "API key" in r.json()["detail"]


def _fake_result(**over):
    r = {"summary": "loop rows", "understanding": "You want every order.", "matches_goal": False,
         "gaps": ["Pick the date column"], "suggestions": [{"title": "All pages", "detail": "Repeat for every page.", "instruction": "Loop with next button"}],
         "output_kind": "data", "output_fields": [{"name": "order", "description": "Order id"}],
         "variables": [], "warnings": [],
         "steps_json": json.dumps([{"id": "l1", "type": "loop", "loop": {"over": "rows", "selector": "tr"},
                                    "steps": [{"id": "c1", "type": "click"}]}])}
    r.update(over)
    return r


def test_compile_with_goal_and_feedback(client, monkeypatch):
    client.put("/settings", json={"anthropic_api_key": "sk-test"})
    assert client.get("/settings").json()["has_api_key"] is True
    prompts = []

    def fake_call(system, content, schema, effort, max_tokens=16000):
        prompts.append(content[0]["text"])
        assert "GOAL" in system and "suggestions" in schema["properties"]
        return _fake_result()

    monkeypatch.setattr(ai, "_call_json", fake_call)
    f = client.post("/flows", json={"name": "x", "steps": [{"id": "p", "type": "type", "secret": True, "value": "hunter2"}]}).json()
    out = client.post(f"/flows/{f['id']}/compile", json={"goal": "Export all orders to CSV", "output_kind": "data",
                                                          "output_fields": ["order", "total"]}).json()
    c = out["compiled"]
    assert c["steps"][0]["steps"][0]["type"] == "click"
    assert c["goal"] == "Export all orders to CSV" and c["matches_goal"] is False
    assert c["suggestions"][0]["title"] == "All pages" and c["output_fields"][0]["name"] == "order"
    assert out["description"] == "Export all orders to CSV"  # goal remembered on the flow
    assert "Export all orders to CSV" in prompts[0] and "order, total" in prompts[0]
    assert "hunter2" not in prompts[0]  # secrets never reach the AI

    # refine: previous build + feedback are sent, goal is reused from the flow
    client.post(f"/flows/{f['id']}/compile", json={"feedback": "Loop with next button"})
    assert "PREVIOUS BUILD" in prompts[1] and "Loop with next button" in prompts[1] and "Export all orders" in prompts[1]


def test_compile_without_body_still_works(client, monkeypatch):
    client.put("/settings", json={"anthropic_api_key": "sk-test"})
    monkeypatch.setattr(ai, "_call_json", lambda *a, **k: _fake_result())
    f = client.post("/flows", json={"name": "x"}).json()
    r = client.post(f"/flows/{f['id']}/compile")
    assert r.status_code == 200 and r.json()["compiled"]["understanding"]


def test_call_json_uses_fallbacks(monkeypatch):
    calls = {}

    class FakeBeta:
        def create(self, **kw):
            calls.update(kw)
            return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text='{"a": 1}')])

    fake = SimpleNamespace(beta=SimpleNamespace(messages=FakeBeta()))
    monkeypatch.setattr(ai, "_client", lambda: (fake, "claude-opus-5-5"))
    assert ai._call_json("s", [{"type": "text", "text": "t"}], {"type": "object"}, "low") == {"a": 1}
    assert calls["fallbacks"] == "default" and calls["model"] == "claude-opus-5-5"
    assert calls["output_config"]["format"]["type"] == "json_schema"
