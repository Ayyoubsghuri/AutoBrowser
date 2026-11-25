import type { Step } from './types';

export const uid = () => Math.random().toString(36).slice(2, 9);

export function stepTitle(s: Step): string {
  const t = s.target;
  const what = t?.text ? `"${t.text}"` : t?.label ? `"${t.label}"` : t?.tag ? `<${t.tag}>` : '';
  switch (s.type) {
    case 'goto': return `Open ${hostPath(s.url || s.value || '')}`;
    case 'click': return `Click ${what}`;
    case 'type': return `Type into ${t?.label || t?.tag || 'field'}`;
    case 'select': return `Choose "${s.label || s.value}"`;
    case 'check': return `Set ${t?.label || t?.text || 'checkbox'} → ${s.value === 'true' ? 'on' : s.value === 'false' ? 'off' : s.value}`;
    case 'press': return `Press ${s.key}`;
    case 'scroll': return 'Scroll';
    case 'wait': return t ? `Wait for ${what}` : `Wait ${(s.ms || 1000) / 1000}s`;
    case 'extract_table': return `Extract table → ${s.name || 'table'}`;
    case 'extract_text': return `Extract text → ${s.name || 'text'}`;
    case 'login': return 'Log in with saved account';
    case 'loop': return `Repeat (${s.loop?.over || 'count'})`;
    case 'if': return 'If…';
    case 'ai': return `AI: ${s.instruction || s.tip || ''}`;
    default: return s.type;
  }
}

export function hostPath(u: string) {
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return u; }
}

export function bestSelector(s: Step) {
  return s.target?.selectors?.[0]?.value;
}

// Merge a recorded navigation into the step list: navigations caused by the
// previous action are implicit; others become explicit "goto" steps.
export function shouldAddGoto(steps: Step[], url: string, ts: number) {
  const last = steps[steps.length - 1];
  if (!last) return true;
  if (last.type === 'goto' && last.url === url) return false;
  if (last.ts && ts - last.ts < 2500 && ['click', 'press', 'type', 'select', 'login'].includes(last.type)) return false;
  return true;
}

/** Steps that read the current data row. */
export const usesRow = (s: Step) => /\{\{\s*row\./.test(`${s.value || ''} ${s.url || ''} ${s.instruction || ''}`);

/** Default "repeat from here": the last page load before the first step that uses row data. */
export function defaultRowStart(steps: Step[]): string | null {
  const first = steps.findIndex(usesRow);
  if (first < 0) return steps[0]?.id ?? null;
  const lastLogin = steps.reduce((acc, s, i) => (/\{\{\s*account\./.test(s.value || '') || s.type === 'login' ? i : acc), -1);
  for (let i = first; i > lastLogin + 1; i--) if (steps[i - 1].type === 'goto') return steps[i - 1].id;
  return steps[first].id;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** If a recorded value equals a cell of the current row, return {{row.<column>}}. */
export function matchColumn(value: string | undefined, row: Record<string, unknown> | null): string | null {
  if (!row || value == null || !norm(value) || /\{\{/.test(value)) return null;
  const flat: [string, unknown][] = [];
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) flat.push([`${k}.${k2}`, v2]);
    else flat.push([k, v]);
  }
  const hit = flat.find(([, v]) => norm(v) === norm(value));
  return hit ? `{{row.${hit[0]}}}` : null;
}
