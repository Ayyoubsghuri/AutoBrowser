import json
from types import SimpleNamespace

import pytest

from app import ai, settings_store


class FakeOpenAI:
    calls: list = []
    reply = '{"a": 1}'
    finish = "stop"

    def __init__(self, api_key=None, base_url=None, **kw):
        FakeOpenAI.calls.append({"init": {"api_key": api_key, "base_url": base_url}})
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        FakeOpenAI.calls.append(kw)
        msg = SimpleNamespace(content=FakeOpenAI.reply, refusal=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=FakeOpenAI.finish)])


@pytest.fixture()
def fake_openai(monkeypatch):
    FakeOpenAI.calls = []
    FakeOpenAI.reply = '{"a": 1}'
    FakeOpenAI.finish = "stop"
    monkeypatch.setattr(ai.openai, "OpenAI", FakeOpenAI)
    return FakeOpenAI


SCHEMA = {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"], "additionalProperties": False}
CONTENT = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAA"}}, {"type": "text", "text": "hi"}]


def test_settings_per_provider(client):
    s = client.put("/settings", json={"provider": "openai", "openai_api_key": "sk-o", "openai_model": "gpt-5-mini"}).json()
    assert s["provider"] == "openai" and s["has_api_key"] and s["model"] == "gpt-5-mini"
    assert s["providers"]["anthropic"]["has_key"] is False and s["providers"]["anthropic"]["model"] == "claude-opus-5-5"
    s = client.put("/settings", json={"provider": "nvidia"}).json()
    assert s["has_api_key"] is False and s["model"] == "meta/llama-3.3-70b-instruct"
    s = client.put("/settings", json={"nvidia_api_key": "nvapi-x", "model": "deepseek-ai/deepseek-r1"}).json()
    assert s["has_api_key"] and s["providers"]["nvidia"]["model"] == "deepseek-ai/deepseek-r1"
    assert "sk-o" not in json.dumps(s) and "nvapi-x" not in json.dumps(s)


def test_missing_key_names_provider(client):
    client.put("/settings", json={"provider": "nvidia"})
    f = client.post("/flows", json={"name": "x"}).json()
    r = client.post(f"/flows/{f['id']}/compile", json={"goal": "x"})
    assert r.status_code == 400 and "NVIDIA" in r.json()["detail"]


def test_openai_strict_schema_and_images(client, fake_openai):
    client.put("/settings", json={"provider": "openai", "openai_api_key": "sk-o"})
    assert ai._call_json("sys", CONTENT, SCHEMA, "high") == {"a": 1}
    init, kw = fake_openai.calls[0]["init"], fake_openai.calls[1]
    assert init == {"api_key": "sk-o", "base_url": None}
    assert kw["model"] == "gpt-5" and kw["reasoning_effort"] == "high"
    assert kw["response_format"]["type"] == "json_schema" and kw["response_format"]["json_schema"]["strict"] is True
    user = kw["messages"][1]["content"]
    assert user[0]["image_url"]["url"].startswith("data:image/jpeg;base64,AAA") and user[1]["text"] == "hi"


def test_openai_custom_base_url(client, fake_openai):
    client.put("/settings", json={"provider": "openai", "openai_api_key": "k", "openai_base_url": "http://localhost:11434/v1/", "openai_model": "llama3.1"})
    ai._call_json("sys", CONTENT, SCHEMA, "low")
    assert fake_openai.calls[0]["init"]["base_url"] == "http://localhost:11434/v1"
    assert "reasoning_effort" not in fake_openai.calls[1]


def test_nvidia_json_mode_text_only_and_lenient_parse(client, fake_openai):
    client.put("/settings", json={"provider": "nvidia", "nvidia_api_key": "nvapi-x", "model": "deepseek-ai/deepseek-r1"})
    fake_openai.reply = '<think>let me see</think>\n```json\n{"a": 2}\n```'
    assert ai._call_json("sys", CONTENT, SCHEMA, "high") == {"a": 2}
    init, kw = fake_openai.calls[0]["init"], fake_openai.calls[1]
    assert init["base_url"] == "https://integrate.api.nvidia.com/v1"
    assert kw["response_format"] == {"type": "json_object"} and "max_tokens" in kw
    assert '"required": ["a"]' in kw["messages"][0]["content"]  # schema spelled out in the prompt
    assert kw["messages"][1]["content"] == "hi"  # text-only model: screenshot dropped


def test_nvidia_incomplete_or_cut_off(client, fake_openai):
    client.put("/settings", json={"provider": "nvidia", "nvidia_api_key": "nvapi-x"})
    fake_openai.reply = '{"b": 1}'
    with pytest.raises(ai.AIUnavailable, match="missing a"):
        ai._call_json("sys", CONTENT, SCHEMA, "low")
    fake_openai.reply, fake_openai.finish = '{"a": 1', "length"
    with pytest.raises(ai.AIUnavailable, match="cut off"):
        ai._call_json("sys", CONTENT, SCHEMA, "low")


def test_compile_via_openai_accepts_steps_as_list(client, fake_openai):
    client.put("/settings", json={"provider": "openai", "openai_api_key": "sk-o"})
    fake_openai.reply = json.dumps({
        "summary": "s", "understanding": "u", "matches_goal": True, "gaps": [], "suggestions": [],
        "output_kind": "data", "output_fields": [], "variables": [], "warnings": [],
        "steps_json": [{"id": "a", "type": "goto", "url": "https://x.test"}],
    })
    f = client.post("/flows", json={"name": "x"}).json()
    out = client.post(f"/flows/{f['id']}/compile", json={"goal": "g"}).json()
    assert out["compiled"]["steps"][0]["url"] == "https://x.test"
