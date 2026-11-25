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
  | 'goto' | 'click' | 'type' | 'select' | 'press' | 'scroll' | 'wait'
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
};

export type Flow = {
  id: string;
  name: string;
  start_url?: string | null;
  description?: string | null;
  steps: Step[];
  compiled?: Compiled | null;
  created: number;
  updated: number;
};

export type Credential = {
  id: string; profile_id: string; site: string; username: string;
  has_password: boolean; has_totp: boolean; extra_keys: string[];
};

export type Profile = {
  id: string; name: string; color: string; proxy?: string | null; notes?: string | null;
  credentials: Credential[]; partition: string;
};

export type TabInfo = {
  id: number; profileId: string | null; title: string; url: string; favicon: string | null;
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
};

export type RunMode = 'exact' | 'assist' | 'compiled';

export type Suggestion = { title: string; detail: string; instruction: string };
export type OutputKind = 'data' | 'action' | 'both';

export type Compiled = {
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
