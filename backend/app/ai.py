"""Claude-powered pieces. Every function here is optional: flows replay
without any AI. The API key is stored encrypted in the local vault."""
from __future__ import annotations

import json
from typing import Any

import anthropic

from . import settings_store
from .schemas import ActRequest, LocateRequest, Step

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AIUnavailable(RuntimeError):
    pass


def _client() -> tuple[anthropic.Anthropic, str]:
    key = settings_store.get_api_key()
    if not key:
        raise AIUnavailable("No Anthropic API key configured (Settings → AI).")
    return anthropic.Anthropic(api_key=key, max_retries=3), settings_store.get_model()


def _call_json(system: str, content: list[dict[str, Any]], schema: dict[str, Any], effort: str, max_tokens: int = 16000) -> dict[str, Any]:
    client, model = _client()
    kwargs: dict[str, Any] = dict(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
    )
    try:
        # Server-side fallback: if the primary model declines, the API retries on a fallback model.
        resp = client.beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
    except anthropic.BadRequestError:
        # Model/platform without fallback support -> plain request.
        resp = client.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        raise AIUnavailable("The model declined this request.")
    if resp.stop_reason == "max_tokens":
        raise AIUnavailable("AI response was cut off (max_tokens). Try a shorter flow.")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if text is None:
        raise AIUnavailable("Empty AI response.")
    return json.loads(text)


# --------------------------------------------------------------------------- compile

COMPILE_SYSTEM = """You turn a browser recording into a robust, repeatable automation flow.

Input: the steps a user recorded by clicking around a website, in order. Each step may carry a
`tip` written by the user. Rules:
- A step with an empty tip means "do exactly this" -> keep it as a deterministic step (no AI).
- A tip explains intent. Use it to generalise: e.g. "do this for every row" -> wrap the following
  steps in a `loop` with {"over":"rows","selector":<row css>}; "next page until the end" ->
  `loop` {"over":"until_missing","selector":<next button css>,"max":50} (runs the child steps, then clicks
  the selector and repeats until it is missing or disabled - so do NOT also add a click on the next button); "type today's date" ->
  value "{{today}}"; "the newest item" -> pick a stable selector (e.g. first row) or, only when
  no selector can express it, an `ai` step with a precise `instruction`.
- Prefer deterministic steps over `ai` steps: they are free, fast and need no API key at run time.
- Keep every recorded selector candidate you can; put the most stable first (testid, id, aria, name, then css, then text).
- Recognise login sequences (username + password + submit) and replace them with ONE `login` step
  whose target selectors map: {"username": [...], "password": [...], "submit": [...], "totp": [...]} in `value` as JSON,
  plus `condition` {"exists": <username field css>} so it is skipped when the session is already logged in.
- Credentials are never written literally: use {{account.username}}, {{account.password}}, {{account.totp}}.
- Inside a rows loop, refer to the current row with {{row.<column>}} and scope selectors with the prefix "{{row}} ".
- Add short `wait` steps (for a selector) after actions that load new content.
- Give extract steps a snake_case `name` - that becomes the output column / dataset name.
Allowed step types: goto, click, type, select, press, scroll, wait, extract_table, extract_text, login, loop, if, ai.
Every step needs a unique short `id`. Return `steps_json` as a JSON array string of steps matching the input step shape."""

COMPILE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "variables": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "steps_json": {"type": "string"},
    },
    "required": ["summary", "variables", "warnings", "steps_json"],
    "additionalProperties": False,
}


def _strip_secrets(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for s in steps:
        s = dict(s)
        if s.get("secret") and s.get("value") and "{{" not in str(s["value"]):
            s["value"] = "{{account.password}}"
        if s.get("steps"):
            s["steps"] = _strip_secrets(s["steps"])
        out.append(s)
    return out


def compile_flow(flow: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "name": flow["name"],
        "start_url": flow.get("start_url"),
        "description": flow.get("description"),
        "steps": _strip_secrets(flow.get("steps") or []),
    }
    result = _call_json(
        COMPILE_SYSTEM,
        [{"type": "text", "text": "Recorded flow:\n" + json.dumps(payload, ensure_ascii=False, indent=1)}],
        COMPILE_SCHEMA,
        effort="high",
        max_tokens=32000,
    )
    raw_steps = json.loads(result["steps_json"])
    steps = [Step.model_validate(s).model_dump(exclude_none=True) for s in raw_steps]
    return {
        "summary": result["summary"],
        "variables": result["variables"],
        "warnings": result["warnings"],
        "steps": steps,
    }


# --------------------------------------------------------------------------- runtime agent

ACT_SYSTEM = """You control a real web browser to complete ONE instruction for the user.
You see the page URL, title, a text excerpt, an optional screenshot and a numbered list of
interactive elements. Choose the single next action. Use `done` as soon as the instruction is
satisfied, and `fail` if it is impossible. Never invent element indexes. For `type`, put the exact
text in `value`; to type saved credentials write {{account.username}}, {{account.password}} or
{{account.totp}} literally (they are filled in locally, you never see them). For `extract`, put the extracted data as a JSON string in `value`."""

ACT_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["click", "type", "select", "press", "scroll", "goto", "wait", "extract", "done", "fail"]},
        "index": {"type": "integer"},
        "value": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["action", "index", "value", "reason"],
    "additionalProperties": False,
}


def _snapshot_content(snap, header: str) -> list[dict[str, Any]]:
    lines = [header, f"URL: {snap.url}", f"Title: {snap.title}", "", "Interactive elements:"]
    for e in snap.elements[:400]:
        bits = [f"[{e.index}] <{e.tag}"]
        for k in ("type", "role"):
            v = getattr(e, k)
            if v:
                bits.append(f' {k}="{v}"')
        bits.append(">")
        for k in ("label", "placeholder", "text", "href", "value"):
            v = getattr(e, k)
            if v:
                bits.append(f" {k}: {v[:120]}")
        lines.append("".join(bits))
    lines += ["", "Visible text excerpt:", snap.text_excerpt[:6000]]
    content: list[dict[str, Any]] = []
    if snap.screenshot_b64:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": snap.screenshot_b64}})
    content.append({"type": "text", "text": "\n".join(lines)})
    return content


def act(req: ActRequest) -> dict[str, Any]:
    header = f"Instruction: {req.instruction}\n"
    if req.variables:
        safe = {k: v for k, v in req.variables.items() if "password" not in k and "totp" not in k}
        header += f"Variables: {json.dumps(safe, ensure_ascii=False)}\n"
    if req.history:
        header += "Actions taken so far:\n- " + "\n- ".join(req.history[-15:]) + "\n"
    return _call_json(ACT_SYSTEM, _snapshot_content(req.snapshot, header), ACT_SCHEMA, effort="low", max_tokens=4000)


LOCATE_SCHEMA = {
    "type": "object",
    "properties": {
        "index": {"type": "integer"},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["index", "confidence", "reason"],
    "additionalProperties": False,
}


def locate(req: LocateRequest) -> dict[str, Any]:
    header = (
        "A recorded selector no longer matches. Find the element that best matches this description.\n"
        f"Description: {req.description}\nRecorded element: {json.dumps(req.recorded or {}, ensure_ascii=False)[:1500]}\n"
        "Return index -1 if nothing matches."
    )
    return _call_json("You locate elements on web pages.", _snapshot_content(req.snapshot, header), LOCATE_SCHEMA, effort="low", max_tokens=2000)
