"""Pydantic models shared by the API and the AI compiler.

A *flow* is an ordered list of steps. Steps recorded from your clicks are
"replay" steps (no AI needed). A step with a ``tip`` tells the AI compiler what
you meant; the compiler may turn it into a loop, a variable, or an ``ai`` step
that is resolved at run time by looking at the live page.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

StepType = Literal[
    "goto",          # open url
    "click",
    "type",          # fill an input (value may contain {{templates}})
    "select",        # <select> option
    "check",         # set a checkbox / radio / switch to on or off (value: true/false or {{row.col}})
    "press",         # keyboard key, e.g. Enter
    "scroll",
    "wait",          # wait ms or wait for selector
    "extract_table", # grab rows of a table / repeated list
    "extract_text",  # grab text of one element (or a list of similar ones)
    "login",         # composite: fill username/password(/totp) for current account
    "loop",          # repeat child steps: over table rows, or until a selector disappears (pagination)
    "if",            # run child steps when a selector exists / text matches
    "ai",            # resolve at run time with the AI agent (needs API key)
]


class SelectorCandidate(BaseModel):
    kind: Literal["css", "xpath", "text", "aria", "testid", "id", "name", "placeholder"]
    value: str
    score: float = 0.5


class Target(BaseModel):
    selectors: list[SelectorCandidate] = Field(default_factory=list)
    tag: Optional[str] = None
    text: Optional[str] = None
    label: Optional[str] = None
    frame: Optional[str] = None
    rect: Optional[dict[str, float]] = None
    # for tables / repeated lists
    columns: Optional[list[str]] = None
    row_selector: Optional[str] = None
    sample: Optional[list[Any]] = None


class Step(BaseModel):
    id: str
    type: StepType
    target: Optional[Target] = None
    url: Optional[str] = None
    value: Optional[str] = None
    key: Optional[str] = None
    ms: Optional[int] = None
    tip: Optional[str] = Field(default=None, description="User hint for the AI. Empty = do exactly what was recorded.")
    instruction: Optional[str] = Field(default=None, description="For ai steps: natural language goal.")
    name: Optional[str] = Field(default=None, description="Variable / output name for extract steps.")
    optional: bool = False
    # control flow
    loop: Optional[dict[str, Any]] = None   # {"over": "rows"|"until_missing"|"count", "selector":..., "max": 50}
    condition: Optional[dict[str, Any]] = None  # {"exists": selector} | {"text_contains": "..."}
    steps: Optional[list["Step"]] = None
    secret: bool = False


Step.model_rebuild()


class UploadFile(BaseModel):
    filename: str
    content_b64: str


class DatasetUpload(BaseModel):
    files: list[UploadFile]
    name: Optional[str] = None
    sheet: Optional[str] = None
    header_row: int = 1
    dataset_id: Optional[str] = Field(default=None, description="Add PDFs to an existing PDF dataset")


class PdfRule(BaseModel):
    name: str
    kind: Literal["form_field", "after_label", "regex", "value"]
    pattern: Optional[str] = None
    values: Optional[dict[str, str]] = None


class DatasetPatch(BaseModel):
    name: Optional[str] = None
    sheet: Optional[str] = None
    header_row: Optional[int] = None
    rules: Optional[list[PdfRule]] = None


class JoinSpec(BaseModel):
    dataset_id: str
    left: str           # column in the main data
    right: str          # matching column in the other file
    prefix: Optional[str] = None  # put the other file's columns under {{row.<prefix>.col}}


class RowFilter(BaseModel):
    column: str
    op: Literal["empty", "not_empty", "equals", "not_equals", "contains", "truthy", "falsy"] = "not_empty"
    value: Optional[str] = None


class FlowData(BaseModel):
    """Run the flow once per row of a data source."""
    dataset_id: str
    joins: list[JoinSpec] = Field(default_factory=list)
    filter: Optional[RowFilter] = None
    start_step_id: Optional[str] = None   # steps before it run once (e.g. login); from it on, once per row
    stop_on_error: bool = False
    first_row: int = 1                    # 1-based, inclusive
    max_rows: Optional[int] = None


class FlowIn(BaseModel):
    name: str
    start_url: Optional[str] = None
    description: Optional[str] = None
    steps: list[dict[str, Any]] = Field(default_factory=list)
    compiled: Optional[dict[str, Any]] = None
    data: Optional[FlowData] = None


class FlowPatch(BaseModel):
    name: Optional[str] = None
    start_url: Optional[str] = None
    description: Optional[str] = None
    steps: Optional[list[dict[str, Any]]] = None
    compiled: Optional[dict[str, Any]] = None
    data: Optional[FlowData] = None


class ProfileIn(BaseModel):
    name: str
    color: str = "#7c9cff"
    proxy: Optional[str] = None
    notes: Optional[str] = None


class ProfilePatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    proxy: Optional[str] = None
    notes: Optional[str] = None


class CredentialIn(BaseModel):
    profile_id: str
    site: str
    username: str
    password: Optional[str] = None
    totp_secret: Optional[str] = None
    extra: dict[str, str] = Field(default_factory=dict)


class CredentialPatch(BaseModel):
    site: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    totp_secret: Optional[str] = None
    extra: Optional[dict[str, str]] = None


class CompileIn(BaseModel):
    goal: Optional[str] = Field(default=None, description="Why the user recorded this / what they want done.")
    output_kind: Optional[Literal["data", "action", "both"]] = None
    output_fields: Optional[list[str]] = None
    feedback: Optional[str] = Field(default=None, description="Changes to apply to the previous AI build.")


class RunIn(BaseModel):
    flow_id: Optional[str] = None
    profile_id: Optional[str] = None
    mode: Literal["replay", "ai"] = "replay"


class RunPatch(BaseModel):
    status: Optional[Literal["running", "success", "failed", "stopped"]] = None
    log: Optional[list[dict[str, Any]]] = None       # appended
    output: Optional[list[dict[str, Any]]] = None    # appended
    finished: bool = False


class SettingsIn(BaseModel):
    provider: Optional[Literal["anthropic", "openai", "nvidia"]] = None
    anthropic_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None
    model: Optional[str] = None            # model for the active (or given) provider
    anthropic_model: Optional[str] = None
    openai_model: Optional[str] = None
    nvidia_model: Optional[str] = None
    openai_base_url: Optional[str] = None  # optional: any OpenAI-compatible server
    human_speed: Optional[float] = None    # 0.5 = faster, 2 = slower
    stealth: Optional[bool] = None
    privacy_mode: Optional[bool] = None    # AI reads page code, never page data


class ElementInfo(BaseModel):
    index: int
    tag: str
    text: Optional[str] = None
    role: Optional[str] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None
    href: Optional[str] = None
    type: Optional[str] = None
    value: Optional[str] = None


class PageSnapshot(BaseModel):
    url: str
    title: str = ""
    elements: list[ElementInfo] = Field(default_factory=list)
    text_excerpt: str = ""
    screenshot_b64: Optional[str] = None  # jpeg


class ActRequest(BaseModel):
    instruction: str
    snapshot: PageSnapshot
    history: list[str] = Field(default_factory=list)
    variables: dict[str, Any] = Field(default_factory=dict)


class LocateRequest(BaseModel):
    description: str
    recorded: Optional[dict[str, Any]] = None
    snapshot: PageSnapshot
