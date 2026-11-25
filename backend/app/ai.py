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

GOAL_RULES = """
The user also told you their GOAL (why they recorded this) and what OUTPUT they want. The goal
is the source of truth; the recording is evidence of how the site works.
- Explain in `understanding` (2-4 sentences, plain words, second person) what you think they want.
- Set `matches_goal` to false when the recording cannot achieve the goal as-is (e.g. they want
  every page but only recorded one, want a field that was never picked, or skipped a step). Build
  the best flow you can anyway: generalise with loops / ai steps where the recording shows enough.
- `gaps`: what is missing or ambiguous that you could NOT fix yourself and the user should record
  or clarify (e.g. "Pick the order date column - it was not captured"). Empty when nothing.
- `suggestions`: 0-5 optional improvements the user can accept (e.g. "Repeat for all pages",
  "Skip orders already exported", "Also capture the tracking number"). Each needs a short
  `title`, a one-sentence `detail`, and `instruction` = what you would change, written so it can be
  sent back to you verbatim. Do NOT apply suggestions in the steps; they are opt-in.
- `output_fields`: the columns/values the run will produce. For scraping goals, make the extract
  steps produce exactly these (name extract steps after the dataset, e.g. `orders`). For pure
  action goals, list what is worth reporting (e.g. `status`), possibly empty.
- `output_kind`: "data" (scraping), "action" (doing something), or "both".
When FEEDBACK and a PREVIOUS BUILD are given, start from the previous build and apply the feedback;
keep everything else stable."""

COMPILE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "understanding": {"type": "string"},
        "matches_goal": {"type": "boolean"},
        "gaps": {"type": "array", "items": {"type": "string"}},
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "instruction": {"type": "string"},
                },
                "required": ["title", "detail", "instruction"],
                "additionalProperties": False,
            },
        },
        "output_kind": {"type": "string", "enum": ["data", "action", "both"]},
        "output_fields": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "description": {"type": "string"}},
                "required": ["name", "description"],
                "additionalProperties": False,
            },
        },
        "variables": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "steps_json": {"type": "string"},
    },
    "required": ["summary", "understanding", "matches_goal", "gaps", "suggestions", "output_kind",
                 "output_fields", "variables", "warnings", "steps_json"],
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


def compile_flow(
    flow: dict[str, Any],
    goal: str | None = None,
    output_kind: str | None = None,
    output_fields: list[str] | None = None,
    feedback: str | None = None,
) -> dict[str, Any]:
    payload = {
        "name": flow["name"],
        "start_url": flow.get("start_url"),
        "recorded_steps": _strip_secrets(flow.get("steps") or []),
    }
    goal = goal or flow.get("description")
    parts = []
    if goal:
        parts.append(f"GOAL (in the user's words):\n{goal}")
    if output_kind:
        parts.append(f"OUTPUT the user wants: {output_kind}" + (f" - fields: {', '.join(output_fields)}" if output_fields else ""))
    elif output_fields:
        parts.append(f"OUTPUT fields the user wants: {', '.join(output_fields)}")
    if not goal:
        parts.append("No goal given: infer the most likely intent from the recording and say so in `understanding`.")
    parts.append("RECORDING:\n" + json.dumps(payload, ensure_ascii=False, indent=1))
    previous = flow.get("compiled")
    if feedback and previous:
        prev = {k: previous.get(k) for k in ("understanding", "output_fields", "steps")}
        parts.append("PREVIOUS BUILD:\n" + json.dumps(prev, ensure_ascii=False, indent=1))
        parts.append(f"FEEDBACK to apply:\n{feedback}")
    elif feedback:
        parts.append(f"Extra instructions from the user:\n{feedback}")

    result = _call_json(
        COMPILE_SYSTEM + GOAL_RULES,
        [{"type": "text", "text": "\n\n".join(parts)}],
        COMPILE_SCHEMA,
        effort="high",
        max_tokens=32000,
    )
    raw_steps = json.loads(result["steps_json"])
    steps = [Step.model_validate(s).model_dump(exclude_none=True) for s in raw_steps]
    return {
        "goal": goal,
        "summary": result["summary"],
        "understanding": result["understanding"],
        "matches_goal": result["matches_goal"],
        "gaps": result["gaps"],
        "suggestions": result["suggestions"],
        "output_kind": result["output_kind"],
        "output_fields": result["output_fields"],
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
