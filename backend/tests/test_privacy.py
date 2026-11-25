import json

from app import ai

REAL = ["John Smith", "ABC-12345", "q=jsmith", "4111", "case/88231", "Jane Roe", "$1,250.00"]

RECORDED = [
    {"id": "g1", "type": "goto", "url": "https://gov.example/search?q=jsmith&page=2"},
    {"id": "t1", "type": "type", "value": "ABC-12345",
     "target": {"selectors": [{"kind": "name", "value": "input[name=\"case\"]"}], "label": "Case number", "tag": "input"}},
    {"id": "c1", "type": "click", "target": {"tag": "a", "text": "John Smith",
     "selectors": [{"kind": "css", "value": "#results tr:nth-of-type(1) a.name"}, {"kind": "text", "value": "a>>John Smith"}]},
     "page_outline": 'URL: https://gov.example/case/9\n<table#results>\n  <th> "Name"\n  <td.name> "Xxxx Xxxxx"'},
    {"id": "e1", "type": "extract_table", "name": "cases", "target": {
        "selectors": [{"kind": "css", "value": "#results"}], "row_selector": "tbody > tr",
        "columns": ["Name", "Case", "Amount"],
        "sample": [{"Name": "Jane Roe", "Case": "case/88231", "Amount": "$1,250.00", "_link": "https://gov.example/case/88231"}]}},
    {"id": "g2", "type": "goto", "url": "https://gov.example/card/4111"},
]


def test_mask_text_keeps_shape_and_templates():
    assert ai.mask_text("John Smith 2024-05-01") == "Xxxx Xxxxx 9999-99-99"
    assert ai.mask_text("محمد 12") == "xxxx 99"
    assert ai.mask_text("{{account.username}}") == "{{account.username}}"
    assert ai.mask_url("https://gov.example/case/88231?q=jsmith&p=2") == "https://gov.example/case/9?q=…&p=…"


def test_private_build_sends_code_not_data_and_restores_values(client, monkeypatch):
    client.put("/settings", json={"anthropic_api_key": "sk-test"})
    assert client.get("/settings").json()["privacy_mode"] is True  # on by default
    sent = {}

    def fake_call(system, content, schema, effort, max_tokens=16000):
        sent["system"], sent["text"] = system, content[0]["text"]
        rec = json.loads(sent["text"].split("RECORDING:\n", 1)[1].split("\n\nPREVIOUS BUILD", 1)[0])
        # the AI echoes recorded steps back (with masked values) inside a rows loop
        steps = rec["recorded_steps"]
        return {"summary": "s", "understanding": "u", "matches_goal": True, "gaps": [], "suggestions": [],
                "output_kind": "data", "output_fields": [], "variables": [], "warnings": [],
                "steps_json": json.dumps([steps[0], steps[1], {"id": "L", "type": "loop", "loop": {"over": "rows", "selector": "#results tbody tr"}, "steps": [steps[2]]}, steps[3]])}

    monkeypatch.setattr(ai, "_call_json", fake_call)
    f = client.post("/flows", json={"name": "Cases", "start_url": "https://gov.example/search?q=jsmith", "steps": RECORDED}).json()

    preview = client.post(f"/flows/{f['id']}/ai-preview", json={"goal": "Export all cases"}).json()
    assert preview["private"] is True
    out = client.post(f"/flows/{f['id']}/compile", json={"goal": "Export all cases"}).json()
    assert preview["text"] == sent["text"]  # the preview is exactly what was sent

    for secret in REAL:
        assert secret not in sent["text"], secret
    # the code is still there: selectors, labels, headers, outline
    for code in ["#results tr:nth-of-type(1) a.name", "input[name=\\\"case\\\"]", "Case number", "\"Amount\"", "<table#results>", "tbody > tr"]:
        assert code in sent["text"], code
    assert "PRIVATE MODE" in sent["system"]

    c = out["compiled"]
    assert c["private"] is True
    goto, typ, loop = c["steps"][0], c["steps"][1], c["steps"][2]
    assert goto["url"] == "https://gov.example/search?q=jsmith&page=2"  # real values restored locally
    assert typ["value"] == "ABC-12345"
    click = loop["steps"][0]
    assert click["target"]["text"] == "John Smith"
    assert {"kind": "text", "value": "a>>John Smith"} in [{"kind": x["kind"], "value": x["value"]} for x in click["target"]["selectors"]]


def test_non_private_mode_sends_data(client, monkeypatch):
    client.put("/settings", json={"anthropic_api_key": "sk-test", "privacy_mode": False})
    f = client.post("/flows", json={"name": "Cases", "steps": RECORDED}).json()
    text = client.post(f"/flows/{f['id']}/ai-preview", json={}).json()["text"]
    assert "John Smith" in text and "ABC-12345" in text


def test_private_runtime_drops_screenshot_and_masks_variables(client, monkeypatch):
    client.put("/settings", json={"anthropic_api_key": "sk-test"})
    seen = {}

    def fake_call(system, content, schema, effort, max_tokens=16000):
        seen["content"] = content
        return {"action": "done", "index": -1, "value": "", "reason": "ok"}

    monkeypatch.setattr(ai, "_call_json", fake_call)
    r = client.post("/ai/act", json={"instruction": "open the newest case", "variables": {"row": {"Name": "Jane Roe"}},
                                     "snapshot": {"url": "https://gov.example/x", "screenshot_b64": "AAAA", "elements": []}})
    assert r.status_code == 200
    assert all(b["type"] == "text" for b in seen["content"])
    assert "Jane Roe" not in seen["content"][0]["text"] and "Xxxx Xxx" in seen["content"][0]["text"]
