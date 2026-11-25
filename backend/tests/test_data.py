import base64
import io
import json

import openpyxl

from app import ai


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def make_xlsx(sheets: dict[str, list[list]]) -> bytes:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_pdf(lines: list[str]) -> bytes:
    """Minimal one-page text PDF."""
    content = "BT /F1 12 Tf 50 750 Td 16 TL " + " ".join(f"({l}) Tj T*" for l in lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer << /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return out


PEOPLE = [["Case ID", "Name", "Agree", "Date"], [1001, "Ana Lima", "yes", None], [1002, "Bo Chen", "", None], [1003, "Cy Diaz", "x", None]]
EXTRA = "case;city;phone\n1001;Rabat;0600\n1003;Fes;0700\n"


def upload(client, filename, data, **kw):
    r = client.post("/datasets", json={"files": [{"filename": filename, "content_b64": b64(data)}], **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_excel_sheets_header_and_types(client):
    import datetime as dt
    rows = [r[:] for r in PEOPLE]
    rows[1][3] = dt.datetime(2024, 5, 1)
    d = upload(client, "people.xlsx", make_xlsx({"Notes": [["ignore me"]], "People": rows}))
    assert d["kind"] == "excel" and d["sheets"] == ["Notes", "People"] and d["sheet"] == "Notes"
    d = client.patch(f"/datasets/{d['id']}", json={"sheet": "People"}).json()
    assert d["columns"] == ["Case ID", "Name", "Agree", "Date"] and d["row_count"] == 3
    assert d["rows"][0] == {"Case ID": "1001", "Name": "Ana Lima", "Agree": "yes", "Date": "2024-05-01"}


def test_join_filter_and_flow_rows(client):
    main = upload(client, "people.xlsx", make_xlsx({"People": PEOPLE}))
    extra = upload(client, "extra.csv", EXTRA.encode())
    assert extra["columns"] == ["case", "city", "phone"]
    flow = client.post("/flows", json={"name": "Fill", "steps": [{"id": "a", "type": "goto", "url": "https://x.test"}],
                                       "data": {"dataset_id": main["id"], "joins": [{"dataset_id": extra["id"], "left": "Case ID", "right": "case"}],
                                                "start_step_id": "a"}}).json()
    assert flow["data"]["joins"][0]["right"] == "case"
    r = client.get(f"/flows/{flow['id']}/data-rows").json()
    assert r["total"] == 3 and "city" in r["columns"]
    assert r["rows"][0]["city"] == "Rabat" and r["rows"][1]["city"] == "" if "city" in r["rows"][1] else True
    assert r["rows"][2]["phone"] == "0700" and r["rows"][2]["_row"] == 3
    # only rows where Agree is ticked; start at the 2nd of those
    client.patch(f"/flows/{flow['id']}", json={"data": {"dataset_id": main["id"], "joins": [{"dataset_id": extra["id"], "left": "Case ID", "right": "case", "prefix": "x"}],
                                                       "filter": {"column": "Agree", "op": "truthy"}, "first_row": 2}})
    r = client.get(f"/flows/{flow['id']}/data-rows").json()
    assert r["total"] == 2 and len(r["rows"]) == 1 and r["rows"][0]["Name"] == "Cy Diaz" and r["rows"][0]["x"]["city"] == "Fes"


def test_pdf_rules_and_private_suggestions(client, monkeypatch):
    d = upload(client, "a.pdf", make_pdf(["Application form", "Applicant: Ana Lima", "File number: 88231"]))
    assert d["kind"] == "pdf" and d["columns"] == ["_file"]
    d = upload(client, "b.pdf", make_pdf(["Application form", "Applicant: Bo Chen", "File number: 99412"]), dataset_id=d["id"])
    assert d["row_count"] == 2
    d = client.patch(f"/datasets/{d['id']}", json={"rules": [
        {"name": "applicant", "kind": "after_label", "pattern": "Applicant"},
        {"name": "file_no", "kind": "regex", "pattern": r"File number:\s*(\d+)"}]}).json()
    assert d["rows"][0] == {"_file": "a.pdf", "applicant": "Ana Lima", "file_no": "88231"}

    client.put("/settings", json={"anthropic_api_key": "sk-test"})  # private mode is on by default
    seen = {}

    def fake(system, content, schema, effort, max_tokens=16000):
        seen["text"] = content[0]["text"]
        return {"rules": [{"name": "applicant", "kind": "after_label", "pattern": "Applicant"}], "notes": ""}

    monkeypatch.setattr(ai, "_call_json", fake)
    out = client.post(f"/datasets/{d['id']}/suggest-rules", json={"fields": ["applicant"]}).json()
    assert out["private"] is True and out["rules"][0]["pattern"] == "Applicant"
    assert "Application form" in seen["text"] and "Applicant:" in seen["text"]  # shared labels readable
    for secret in ("Ana", "Lima", "88231", "Chen", "99412"):
        assert secret not in seen["text"]
    # whole-document AI extraction is blocked in private mode with a cloud provider
    r = client.post(f"/datasets/{d['id']}/ai-extract", json={"fields": ["applicant"]})
    assert r.status_code == 403 and "local model" in r.json()["detail"]


def test_ai_extract_with_local_model(client, monkeypatch):
    d = upload(client, "a.pdf", make_pdf(["Applicant: Ana Lima"]))
    client.put("/settings", json={"provider": "openai", "openai_api_key": "x", "openai_base_url": "http://localhost:11434/v1"})
    monkeypatch.setattr(ai, "_call_json", lambda *a, **k: {"applicant": "Ana Lima"})
    d = client.post(f"/datasets/{d['id']}/ai-extract", json={"fields": ["applicant"]}).json()
    assert d["rows"][0]["applicant"] == "Ana Lima"


def test_build_prompt_knows_the_data_but_masks_it(client, monkeypatch):
    main = upload(client, "people.xlsx", make_xlsx({"People": PEOPLE}))
    flow = client.post("/flows", json={"name": "Fill", "steps": [{"id": "s1", "type": "type", "value": "{{row.Name}}"}],
                                       "data": {"dataset_id": main["id"], "start_step_id": "s1"}}).json()
    text = client.post(f"/flows/{flow['id']}/ai-preview", json={"goal": "fill the form for each person"}).json()["text"]
    assert '"Case ID"' in text and "start_step_id" in text and "Ana" not in text and "Xxx Xxxx" in text


def test_results_xlsx(client):
    r = client.post("/runs", json={}).json()
    client.patch(f"/runs/{r['id']}", json={"output": [
        {"name": "_rows", "data": [{"_row": 1, "_status": "success", "_message": "", "Name": "Ana", "confirmation": "C-1"}]},
        {"name": "_rows", "data": [{"_row": 2, "_status": "failed", "_message": "field not found", "Name": "Bo"}]}]})
    data = client.get(f"/runs/{r['id']}/results.xlsx").content
    ws = openpyxl.load_workbook(io.BytesIO(data))["Rows"]
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0][:3] == ("_row", "_status", "_message") and rows[2][1] == "failed" and "confirmation" in rows[0]
