"""AI pieces (Claude, OpenAI or NVIDIA). Every function here is optional: flows
replay without any AI. API keys are stored encrypted in the local vault."""
from __future__ import annotations

import json
import re
from typing import Any

import anthropic
import openai

from . import settings_store
from .schemas import ActRequest, LocateRequest, Step

FALLBACK_BETA = "server-side-fallback-2026-07-01"
PROVIDER_NAMES = {"anthropic": "Anthropic (Claude)", "openai": "OpenAI", "nvidia": "NVIDIA"}


class AIUnavailable(RuntimeError):
    pass


def _key_or_fail(provider: str) -> str:
    key = settings_store.get_api_key(provider)
    if not key:
        raise AIUnavailable(f"No {PROVIDER_NAMES[provider]} API key configured (Settings → AI).")
    return key


def _client() -> tuple[anthropic.Anthropic, str]:
    key = _key_or_fail("anthropic")
    return anthropic.Anthropic(api_key=key, max_retries=3), settings_store.get_model("anthropic")


def _openai_client(provider: str) -> tuple[openai.OpenAI, str]:
    key = _key_or_fail(provider)
    return (
        openai.OpenAI(api_key=key, base_url=settings_store.get_base_url(provider), max_retries=3, timeout=600),
        settings_store.get_model(provider),
    )


def _call_json(system: str, content: list[dict[str, Any]], schema: dict[str, Any], effort: str, max_tokens: int = 16000) -> dict[str, Any]:
    provider = settings_store.get_provider()
    if provider == "anthropic":
        return _call_anthropic(system, content, schema, effort, max_tokens)
    return _call_openai_compatible(provider, system, content, schema, effort, max_tokens)


# --------------------------------------------------------------------------- Claude

def _call_anthropic(system, content, schema, effort, max_tokens) -> dict[str, Any]:
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


# --------------------------------------------------------------------------- OpenAI / NVIDIA

def _to_openai_content(content: list[dict[str, Any]], images: bool) -> list[dict[str, Any]] | str:
    parts: list[dict[str, Any]] = []
    for b in content:
        if b["type"] == "text":
            parts.append({"type": "text", "text": b["text"]})
        elif b["type"] == "image" and images:
            src = b["source"]
            parts.append({"type": "image_url", "image_url": {"url": f"data:{src['media_type']};base64,{src['data']}"}})
    if all(p["type"] == "text" for p in parts):
        return "\n\n".join(p["text"] for p in parts)
    return parts


def _vision_model(model: str) -> bool:
    return bool(re.search(r"vision|vl\b|-vl|llava|gemma-3|phi-4-multimodal|nemotron-nano-vl|maverick|scout", model, re.I))


def parse_json_text(text: str) -> dict[str, Any]:
    """Lenient JSON extraction for models without strict structured output."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise


def _call_openai_compatible(provider, system, content, schema, effort, max_tokens) -> dict[str, Any]:
    client, model = _openai_client(provider)
    strict = provider == "openai"
    sys_text = system
    if not strict:
        # NVIDIA-hosted models: no strict schema enforcement, so spell the schema out.
        sys_text += ("\n\nReply with ONLY one JSON object (no prose, no code fences) that matches this JSON schema:\n"
                     + json.dumps(schema))
    images = provider == "openai" or _vision_model(model)
    kwargs: dict[str, Any] = dict(
        model=model,
        messages=[{"role": "system", "content": sys_text},
                  {"role": "user", "content": _to_openai_content(content, images)}],
    )
    if strict:
        kwargs["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "schema": schema, "strict": True}}
        kwargs["max_completion_tokens"] = max_tokens
        if re.match(r"(gpt-5|o\d)", model):
            kwargs["reasoning_effort"] = {"low": "low", "medium": "medium"}.get(effort, "high")
    else:
        kwargs["response_format"] = {"type": "json_object"}
        kwargs["max_tokens"] = min(max_tokens, 16000)
    try:
        resp = client.chat.completions.create(**kwargs)
    except openai.BadRequestError:
        if not strict and "response_format" in kwargs:
            kwargs.pop("response_format")  # some hosted models reject json mode; the prompt still asks for JSON
            resp = client.chat.completions.create(**kwargs)
        else:
            raise
    choice = resp.choices[0]
    msg = choice.message
    if getattr(msg, "refusal", None) or choice.finish_reason == "content_filter":
        raise AIUnavailable("The model declined this request.")
    if choice.finish_reason == "length":
        raise AIUnavailable("AI response was cut off (token limit). Try a shorter flow or another model.")
    if not msg.content:
        raise AIUnavailable("Empty AI response.")
    try:
        data = parse_json_text(msg.content)
    except json.JSONDecodeError:
        raise AIUnavailable(f"{model} did not return valid JSON. Try a stronger model.")
    missing = [k for k in schema.get("required", []) if k not in data]
    if missing:
        raise AIUnavailable(f"{model} returned an incomplete answer (missing {', '.join(missing)}). Try a stronger model.")
    return data


# --------------------------------------------------------------------------- private mode
# The AI may read the site's *code* (tags, ids, classes, names, labels, headers),
# never its *data*. Data values are replaced by their shape: "Jo 12" -> "Xx 99".

import copy
import unicodedata
from urllib.parse import urlsplit

_TEMPLATE = re.compile(r"^\s*(\{\{[^}]+\}\}\s*)+$")


def mask_text(value: Any, max_len: int = 40) -> Any:
    if not isinstance(value, str) or not value or _TEMPLATE.match(value):
        return value
    out = []
    for ch in " ".join(value.split()):
        if ch.isdigit():
            out.append("9")
        elif ch.isalpha():
            out.append("X" if unicodedata.category(ch) == "Lu" else "x")
        else:
            out.append(ch)
    m = "".join(out)
    return m if len(m) <= max_len else f"{m[:max_len]}…({len(value)})"


def mask_url(url: Any) -> Any:
    if not isinstance(url, str) or not url or "{{" in url:
        return url
    try:
        u = urlsplit(url)
    except ValueError:
        return mask_text(url)
    path = re.sub(r"\d+", "9", u.path)
    query = "&".join(f"{kv.split('=')[0]}=…" for kv in u.query.split("&") if kv)
    return f"{u.scheme}://{u.netloc}{path}" + (f"?{query}" if query else "") if u.scheme else mask_text(url)


def mask_deep(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: mask_deep(x) for k, x in v.items()}
    if isinstance(v, list):
        return [mask_deep(x) for x in v]
    return mask_text(v) if isinstance(v, str) else ("9" if isinstance(v, (int, float)) and not isinstance(v, bool) else v)


def redact_target(t: dict[str, Any] | None) -> dict[str, Any] | None:
    if not t:
        return t
    t = dict(t)
    # text selectors are page *content*; attribute/structure selectors are the site's code
    t["selectors"] = [c for c in t.get("selectors") or [] if c.get("kind") != "text"]
    for k in ("text",):
        if t.get(k):
            t[k] = mask_text(t[k])
    if t.get("sample"):
        t["sample"] = mask_deep(t["sample"])
    if t.get("frame"):
        t["frame"] = mask_url(t["frame"])
    t.pop("rect", None)
    return t


def redact_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for s in steps:
        s = dict(s)
        s["target"] = redact_target(s.get("target"))
        if s["target"] is None:
            s.pop("target")
        for k in ("url",):
            if s.get(k):
                s[k] = mask_url(s[k])
        for k in ("value", "label"):
            if s.get(k):
                s[k] = mask_text(s[k])
        if "sample" in s:
            s["sample"] = mask_deep(s["sample"])
        if s.get("steps"):
            s["steps"] = redact_steps(s["steps"])
        out.append(s)
    return out


def _index_steps(steps: list[dict[str, Any]], acc: dict[str, dict[str, Any]] | None = None) -> dict[str, dict[str, Any]]:
    acc = {} if acc is None else acc
    for s in steps:
        if s.get("id"):
            acc[s["id"]] = s
        _index_steps(s.get("steps") or [], acc)
    return acc


def restore_private(compiled_steps: list[dict[str, Any]], recorded: list[dict[str, Any]]) -> None:
    """Put back the real values the AI only saw masked (same step id => same step)."""
    originals = _index_steps(recorded)

    def fix(steps: list[dict[str, Any]]) -> None:
        for s in steps:
            o = originals.get(s.get("id") or "")
            if o and o.get("type") == s.get("type"):
                if s.get("url") and o.get("url") and s["url"] == mask_url(o["url"]):
                    s["url"] = o["url"]
                for k in ("value", "label"):
                    if s.get(k) and o.get(k) and s[k] == mask_text(o[k]):
                        s[k] = o[k]
                ot = o.get("target") or {}
                st = s.get("target")
                if st is not None and ot:
                    have = {c.get("value") for c in st.get("selectors") or []}
                    st.setdefault("selectors", []).extend(
                        c for c in ot.get("selectors") or [] if c.get("kind") == "text" and c.get("value") not in have)
                    for k in ("text", "frame"):
                        if ot.get(k) and (not st.get(k) or st[k] == mask_text(ot[k]) or st[k] == mask_url(ot[k])):
                            st[k] = ot[k]
            fix(s.get("steps") or [])

    fix(compiled_steps)


PRIVATE_RULES = """
PRIVATE MODE: you see the site's code, never its data. Every data value in the recording and the
page outlines is masked by shape (X = upper-case letter, x = lower-case, 9 = digit; "…" = cut).
- Never put masked strings into selectors, values or conditions; build selectors from ids, classes,
  names, roles, data-* attributes, labels, column headers and structure.
- Keep the recorded `id` on every step that comes from a recorded step, so the real values can be
  restored locally after you answer.
- In `understanding`, describe the data by its field names, not by example values."""

OUTLINE_RULES = """
Recorded steps may carry `page_outline`: an indented outline of the page's HTML at that moment
(tags with #id .classes and key attributes; data shown by shape, long runs of similar rows
collapsed). Use it to pick stable selectors, row containers, column order and pagination controls.
Never copy `page_outline` into your steps."""

_MAX_OUTLINE_CHARS = 60000


def _cap_outlines(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    budget = _MAX_OUTLINE_CHARS
    out = []
    for s in steps:
        if s.get("page_outline"):
            s = dict(s)
            if budget <= 0:
                s.pop("page_outline")
            else:
                s["page_outline"] = s["page_outline"][:budget]
                budget -= len(s["page_outline"])
        out.append(s)
    return out


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
- Details on each item's own page (e.g. the price is only on the product page): Pick-table the list
  (`extract_table`, named e.g. "products"; its rows include `_link`), then ONE `loop` step
  {"over":"items","from":"products","open":"link"} whose child steps run on each item's page
  (extract_text there; results merge with the item's list columns). Without links use
  {"over":"items","open":"click","list_url":<list page url>,"row_selector":<css of each row>,
  "click_target":{"selectors":[{"kind":"css","value":"{{row}} a"}]}}. Inside, {{item.<column>}} is the
  current item. If the list has several pages, put the extract_table inside an until_missing loop
  first (rows accumulate), then the items loop after it. A recorded `loop` with over "items" is
  already correct: keep it.
- File fields: an `upload` step (target = the input[type=file], value = full path(s) separated by ';' or a
  column such as {{row.file_path}} - PDF data sources provide `file_path`). Never click a file field.
- Downloads: a `download` step whose target is the link/button that downloads, value = file name to save
  as, e.g. "receipt_{{row.Case ID}}.pdf" (empty keeps the site's name); the saved path goes into the
  row's results.
- New tabs / pop-up windows opened by the page are followed automatically, and when they close the
  flow continues on the page that opened them. Use a `tab` step with value "close" to close a pop-up
  that stays open (or "back" to return without closing).
- Where a person is needed (CAPTCHA, SMS / e-mail code that is not a saved TOTP, a final check before
  submitting), add a `pause` step with `value` telling the person what to do; add
  `condition` {"captcha": true} to pause only when a CAPTCHA is actually showing. Steps that fail
  while a CAPTCHA is visible pause automatically and are retried.
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


DATA_RULES = """
DATA: this flow runs ONCE PER ROW of the user's data (Excel / CSV / PDFs, possibly joined from several
files). Steps before the step whose id is `start_step_id` run once (e.g. login); that step and all
after it run for every row. Keep that id on the step that starts the per-row part, and make the
per-row part end in a state where it can start again (e.g. back on an empty form).
- Values can be formatted with filters, e.g. {{row.Date | date:DD/MM/YYYY}}, {{row.Name | upper}}; available:
  upper, lower, title, trim, digits, nospace, first, last, slice:a:b, replace:"x":"y", split:" ":1, pad:6,
  prefix:"+", suffix:"", default:"-", number:2 (number:2:, for a comma), yesno:Oui:Non,
  date:<format with YYYY YY MM M DD D HH mm ss>, parsedate:MM/DD/YYYY (read unusual input orders first).
  Excel dates arrive as YYYY-MM-DD.
- Use {{row.<column>}} in `value` / `url` / `instruction` (columns of joined files under a prefix: {{row.<prefix>.<column>}}).
- Checkboxes, radios and switches: a `check` step whose `value` is "true", "false" or {{row.<column>}}
  (yes / x / 1 / true / oui count as on). Do not use `click` for these: clicking toggles.
- Row conditions: `if` step (or `condition` on any step) {"row": "<column>", "op": "truthy|falsy|empty|not_empty|equals|not_equals|contains", "value": "..."}.
- Do NOT add a `loop` over the data rows: the runner already repeats per row. Use loops only for things on the page.
- If the row has a value worth recording after submitting (a confirmation number), extract it with an
  `extract_text` step: per-row extracts are added to that row's result."""


def _data_context(flow: dict[str, Any], private: bool) -> str | None:
    cfg = flow.get("data")
    if not cfg:
        return None
    from . import data_rows
    try:
        columns, rows, total = data_rows.resolve(cfg)
    except LookupError:
        return None
    sample = {k: v for k, v in (rows[0] if rows else {}).items() if not k.startswith("_")}
    info = {
        "rows": total,
        "columns": columns,
        "joins": [{"left": j.get("left"), "right": j.get("right"), "prefix": j.get("prefix")} for j in cfg.get("joins") or []],
        "filter": cfg.get("filter"),
        "start_step_id": cfg.get("start_step_id"),
        "example_row": mask_deep(sample) if private else sample,
    }
    return "DATA:\n" + json.dumps(info, ensure_ascii=False, indent=1)


def build_compile_prompt(
    flow: dict[str, Any],
    goal: str | None = None,
    output_kind: str | None = None,
    output_fields: list[str] | None = None,
    feedback: str | None = None,
    private: bool | None = None,
) -> tuple[str, str]:
    """Returns (system, user text) exactly as they would be sent to the AI."""
    private = settings_store.get_privacy() if private is None else private
    steps = _cap_outlines(_strip_secrets(flow.get("steps") or []))
    if private:
        steps = redact_steps(steps)
    payload = {
        "name": flow["name"],
        "start_url": mask_url(flow.get("start_url")) if private else flow.get("start_url"),
        "recorded_steps": steps,
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
    data_note = _data_context(flow, private)
    if data_note:
        parts.append(data_note)
    previous = flow.get("compiled")
    if feedback and previous:
        prev_steps = previous.get("steps")
        prev = {"understanding": previous.get("understanding"), "output_fields": previous.get("output_fields"),
                "steps": redact_steps(prev_steps or []) if private else prev_steps}
        parts.append("PREVIOUS BUILD:\n" + json.dumps(prev, ensure_ascii=False, indent=1))
        parts.append(f"FEEDBACK to apply:\n{feedback}")
    elif feedback:
        parts.append(f"Extra instructions from the user:\n{feedback}")
    system = COMPILE_SYSTEM + GOAL_RULES + OUTLINE_RULES + (DATA_RULES if flow.get("data") else "") + (PRIVATE_RULES if private else "")
    return system, "\n\n".join(parts)


def compile_flow(
    flow: dict[str, Any],
    goal: str | None = None,
    output_kind: str | None = None,
    output_fields: list[str] | None = None,
    feedback: str | None = None,
) -> dict[str, Any]:
    private = settings_store.get_privacy()
    goal = goal or flow.get("description")
    system, text = build_compile_prompt(flow, goal, output_kind, output_fields, feedback, private)
    result = _call_json(
        system,
        [{"type": "text", "text": text}],
        COMPILE_SCHEMA,
        effort="high",
        max_tokens=32000,
    )
    raw = result["steps_json"]
    raw_steps = raw if isinstance(raw, list) else json.loads(raw)
    steps = [Step.model_validate(s).model_dump(exclude_none=True) for s in raw_steps]
    if private:
        restore_private(steps, flow.get("steps") or [])
        if flow.get("compiled") and feedback:
            restore_private(steps, flow["compiled"].get("steps") or [])
    return {
        "private": private,
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


def _private_snapshot(snap):
    snap = snap.model_copy()
    snap.screenshot_b64 = None  # never send pixels in private mode
    return snap


def act(req: ActRequest) -> dict[str, Any]:
    private = settings_store.get_privacy()
    snap = _private_snapshot(req.snapshot) if private else req.snapshot
    header = f"Instruction: {req.instruction}\n"
    if private:
        header += ("PRIVATE MODE: page data is masked by shape (X/x = letters, 9 = digits). Choose elements by "
                   "structure, labels and position. To type a variable, write it as a template, e.g. {{row.name}}; "
                   "it is filled in locally.\n")
    if req.variables:
        safe = {k: v for k, v in req.variables.items() if "password" not in k and "totp" not in k}
        if private:
            safe = mask_deep(safe)
        header += f"Variables: {json.dumps(safe, ensure_ascii=False)}\n"
    if req.history:
        header += "Actions taken so far:\n- " + "\n- ".join(req.history[-15:]) + "\n"
    return _call_json(ACT_SYSTEM, _snapshot_content(snap, header), ACT_SCHEMA, effort="low", max_tokens=4000)


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
    if settings_store.get_privacy():
        req = req.model_copy(update={"snapshot": _private_snapshot(req.snapshot),
                                     "recorded": redact_target(req.recorded),
                                     "description": mask_text(req.description, 120) if req.description else req.description})
    header = (
        "A recorded selector no longer matches. Find the element that best matches this description.\n"
        f"Description: {req.description}\nRecorded element: {json.dumps(req.recorded or {}, ensure_ascii=False)[:1500]}\n"
        "Return index -1 if nothing matches."
    )
    return _call_json("You locate elements on web pages.", _snapshot_content(req.snapshot, header), LOCATE_SCHEMA, effort="low", max_tokens=2000)


# --------------------------------------------------------------------------- data sources (Excel / PDF)

def is_local_provider() -> bool:
    if settings_store.get_provider() != "openai":
        return False
    base = (settings_store.get_base_url("openai") or "").lower()
    return any(h in base for h in ("://localhost", "://127.0.0.1", "://0.0.0.0", "://[::1]"))


def template_text(texts: list[str]) -> list[str]:
    """Private mode for PDFs: words that appear in *every* file are the form's own labels;
    everything else is data and gets masked by shape."""
    token = re.compile(r"\S+")
    common = set(token.findall(texts[0])) if texts else set()
    for t in texts[1:]:
        common &= set(token.findall(t))
    if len(texts) < 2:
        common = set()
    out = []
    for t in texts:
        lines = []
        for line in t.splitlines():
            lines.append(token.sub(lambda m: m.group(0) if m.group(0) in common else mask_text(m.group(0), 30), line))
        out.append("\n".join(lines))
    return out


RULES_SCHEMA = {
    "type": "object",
    "properties": {
        "rules": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": ["form_field", "after_label", "regex"]},
                    "pattern": {"type": "string"},
                },
                "required": ["name", "kind", "pattern"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["rules", "notes"],
    "additionalProperties": False,
}


def suggest_pdf_rules(files: list[dict[str, Any]], fields: list[str]) -> dict[str, Any]:
    private = settings_store.get_privacy() and not is_local_provider()
    sample = files[:3]
    texts = [f.get("text", "")[:6000] for f in sample]
    if private:
        texts = template_text(texts)
    form_fields = sorted({k for f in files for k in f.get("fields", {})})
    body = [
        f"Fields the user wants from each PDF: {', '.join(fields) if fields else '(suggest the useful ones)'}",
        f"Fillable form fields present: {', '.join(form_fields) if form_fields else 'none'}",
    ]
    for i, t in enumerate(texts):
        body.append(f"--- PDF {i + 1} text ---\n{t}")
    system = (
        "You write extraction rules that run locally on PDF text, one rule per wanted field.\n"
        "kinds: form_field (pattern = exact fillable field name, best when present), after_label (pattern = the "
        "label text printed before the value, e.g. 'Invoice No'), regex (Python regex, use one capture group).\n"
        "Prefer form_field, then after_label, then regex. Field `name` is the column name the user will see."
    )
    if private:
        system += ("\nPRIVATE MODE: words that differ between files are masked by shape (X/x letters, 9 digits); "
                   "only the form's shared labels are readable. Build rules from labels and value shapes.")
    return _call_json(system, [{"type": "text", "text": "\n\n".join(body)}], RULES_SCHEMA, effort="medium", max_tokens=8000)


def extract_pdf_values(f: dict[str, Any], fields: list[str]) -> dict[str, str]:
    schema = {"type": "object", "properties": {k: {"type": "string"} for k in fields},
              "required": list(fields), "additionalProperties": False}
    text = f.get("text", "")[:30000]
    form = json.dumps(f.get("fields", {}), ensure_ascii=False)[:4000]
    return _call_json(
        "Extract the requested fields from this document. Use an empty string when a field is absent. Copy values exactly.",
        [{"type": "text", "text": f"Fields: {', '.join(fields)}\nForm fields: {form}\n\nDocument text:\n{text}"}],
        schema, effort="low", max_tokens=4000)
