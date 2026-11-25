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
