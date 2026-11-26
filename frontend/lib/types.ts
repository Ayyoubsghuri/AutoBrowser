export type SelectorCandidate = { kind: string; value: string; score?: number };

export type Target = {
  selectors: SelectorCandidate[];
  tag?: string;
  text?: string;
  label?: string;
  frame?: string;
  rect?: { x: number; y: number; w: number; h: number };
  columns?: string[];
  row_selector?: string;
  sample?: Record<string, string>[];
};

export type StepType =
  | 'goto' | 'click' | 'type' | 'select' | 'check' | 'press' | 'scroll' | 'wait'
  | 'extract_table' | 'extract_text' | 'login' | 'loop' | 'if' | 'ai';

export type Step = {
  id: string;
  type: StepType;
  target?: Target;
  url?: string;
  value?: string;
  label?: string;
  key?: string;
  ms?: number;
  tip?: string;
  instruction?: string;
  name?: string;
  optional?: boolean;
  secret?: boolean;
  sample?: unknown;
  rowCount?: number;
  loop?: { over: string; selector?: string; max?: number; count?: number };
  condition?: Record<string, unknown>;
  steps?: Step[];
  ts?: number;
  page_outline?: string; // masked HTML outline captured while recording
};

export type Flow = {
  id: string;
  name: string;
  start_url?: string | null;
  description?: string | null;
  steps: Step[];
  compiled?: Compiled | null;
  data?: FlowData | null;
  created: number;
  updated: number;
};

export type Credential = {
  id: string; profile_id: string; site: string; username: string;
  has_password: boolean; has_totp: boolean; extra_keys: string[];
};

export type Profile = {
  id: string; name: string; color: string; proxy?: string | null; notes?: string | null;
  credentials: Credential[]; partition: string; engine?: Engine;
};

export type Engine = 'chromium' | 'firefox';

export type TabInfo = {
  id: number; engine?: Engine; profileId: string | null; title: string; url: string; favicon: string | null;
  loading: boolean; canGoBack: boolean; canGoForward: boolean;
};

export type RunLog = { runId: string; flowId: string; profileId: string | null; t: number; level: string; msg: string; step?: string };

export type Run = {
  id: string; flow_id: string | null; profile_id: string | null; mode: string; status: string;
  log: { t: number; level: string; msg: string }[]; output: { name: string; data: unknown }[];
  started: number; finished: number | null;
};

export type ProviderInfo = { has_key: boolean; model: string; base_url?: string };
export type Settings = {
  provider: 'anthropic' | 'openai' | 'nvidia';
  has_api_key: boolean; // for the active provider
  model: string;
  providers: Record<'anthropic' | 'openai' | 'nvidia', ProviderInfo>;
  human_speed: number;
  stealth: boolean;
  privacy_mode: boolean; // AI reads page code, never page data
  default_engine?: Engine;
};

export type RunMode = 'exact' | 'assist' | 'compiled';

export type Suggestion = { title: string; detail: string; instruction: string };
export type OutputKind = 'data' | 'action' | 'both';

export type Compiled = {
  private?: boolean;
  goal?: string | null;
  summary: string;
  understanding?: string;
  matches_goal?: boolean;
  gaps?: string[];
  suggestions?: Suggestion[];
  output_kind?: OutputKind;
  output_fields?: { name: string; description: string }[];
  variables: string[];
  warnings: string[];
  steps: Step[];
};

export type Dataset = {
  id: string;
  name: string;
  kind: 'excel' | 'csv' | 'pdf';
  columns: string[];
  row_count: number;
  rows: Record<string, string>[];
  sheets: string[];
  sheet?: string | null;
  header_row: number;
  files: { name: string; pages?: number; form_fields: string[] }[];
  rules: PdfRule[];
};

export type PdfRule = { name: string; kind: 'form_field' | 'after_label' | 'regex' | 'value'; pattern?: string; values?: Record<string, string> };

export type FilterOp = 'empty' | 'not_empty' | 'equals' | 'not_equals' | 'contains' | 'truthy' | 'falsy';

export type FlowData = {
  dataset_id: string;
  joins: { dataset_id: string; left: string; right: string; prefix?: string | null }[];
  filter?: { column: string; op: FilterOp; value?: string | null } | null;
  start_step_id?: string | null;
  stop_on_error?: boolean;
  first_row?: number;
  max_rows?: number | null;
};

export type RunProgress = { runId: string; flowId: string; done: number; total: number; ok: number; failed: number };
