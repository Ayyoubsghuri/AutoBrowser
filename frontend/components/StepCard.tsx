'use client';
import {
  ArrowDown, ArrowUp, Bot, Clock, Globe, Keyboard, KeyRound, List, MousePointerClick, Repeat, ScrollText, Table2, Trash2, Type, GitBranch, ChevronDown, ScanText, CheckSquare, Repeat1, Hand,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { bridge } from '@/lib/bridge';
import type { Step } from '@/lib/types';
import { bestSelector, stepTitle } from '@/lib/steps';

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  goto: Globe, click: MousePointerClick, type: Type, select: ChevronDown, press: Keyboard, scroll: ScrollText,
  check: CheckSquare, pause: Hand, wait: Clock, extract_table: Table2, extract_text: ScanText, login: KeyRound, loop: Repeat, if: GitBranch, ai: Bot,
};

const FORMATS: { label: string; filter: string }[] = [
  { label: 'Date → 31/12/2024', filter: 'date:DD/MM/YYYY' },
  { label: 'Date → 2024-12-31', filter: 'date:YYYY-MM-DD' },
  { label: 'Date → 12/31/2024', filter: 'date:MM/DD/YYYY' },
  { label: 'UPPER CASE', filter: 'upper' },
  { label: 'lower case', filter: 'lower' },
  { label: 'Title Case', filter: 'title' },
  { label: 'Digits only', filter: 'digits' },
  { label: 'No spaces', filter: 'nospace' },
  { label: 'First word', filter: 'first' },
  { label: 'Last word', filter: 'last' },
  { label: 'Number, 2 decimals', filter: 'number:2' },
  { label: 'If empty → …', filter: 'default:"-"' },
];

/** Adds a formatting filter to the last {{…}} in a value. */
function addFormat(value: string, filter: string) {
  const i = value.lastIndexOf('}}');
  if (i < 0) return value;
  return `${value.slice(0, i).trimEnd()} | ${filter}}}${value.slice(i + 2)}`;
}

function FormatPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (!/\{\{/.test(value)) return null;
  return (
    <select className="select small" style={{ width: 92, flex: 'none' }} value="" title="Format the value (date, case, digits…)"
      onChange={(e) => e.target.value && onChange(addFormat(value, e.target.value))}>
      <option value="">ƒ format…</option>
      {FORMATS.map((f) => <option key={f.filter} value={f.filter}>{f.label}</option>)}
    </select>
  );
}

/** Shows what a template turns into for the sample row. */
function ValuePreview({ value, sampleRow }: { value?: string; sampleRow?: Record<string, unknown> | null }) {
  const [out, setOut] = useState<{ text?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!value || !/\{\{/.test(value)) { setOut(null); return; }
    let alive = true;
    bridge().previewTemplate(value, { row: sampleRow || {}, account: { username: '(your saved username)', password: '••••••', totp: '••••••' } })
      .then((r) => alive && setOut(r)).catch(() => {});
    return () => { alive = false; };
  }, [value, sampleRow]);
  if (!out) return null;
  return out.error
    ? <div className="small" style={{ color: 'var(--rec)' }}>⚠ {out.error}</div>
    : <div className="small muted ellipsis" title={out.text}>→ <span style={{ color: 'var(--ink)' }}>{out.text || '(empty)'}</span></div>;
}

/** Lets a value come from a column of the current data row. */
function ColumnPicker({ columns, onPick }: { columns: string[]; onPick: (tpl: string) => void }) {
  if (!columns.length) return null;
  return (
    <select className="select small" style={{ width: 120, flex: 'none' }} value="" title="Use a column of your data"
      onChange={(e) => e.target.value && onPick(`{{row.${e.target.value}}}`)}>
      <option value="">↳ column…</option>
      {columns.filter((c) => !c.startsWith('_')).map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

export function StepCard({ step, index, onChange, onRemove, onMove, readOnly = false, columns = [], sampleRow = null, rowStart = false, onSetRowStart, onRepeatForItems, onUndoRepeat }: {
  step: Step; index: number;
  onChange?: (s: Step) => void; onRemove?: () => void; onMove?: (dir: -1 | 1) => void; readOnly?: boolean;
  columns?: string[]; sampleRow?: Record<string, unknown> | null; rowStart?: boolean; onSetRowStart?: () => void;
  onRepeatForItems?: () => void; onUndoRepeat?: () => void;
}) {
  const Icon = ICONS[step.type] || List;
  const set = (patch: Partial<Step>) => onChange?.({ ...step, ...patch });
  const sel = bestSelector(step);
  return (
    <div className="card compact step" style={rowStart ? { borderColor: 'color-mix(in srgb, var(--ok) 55%, transparent)' } : undefined}>
      {rowStart && <div className="small row" style={{ color: 'var(--ok)', fontWeight: 600 }}><Repeat1 size={13} /> Repeats for each data row from here</div>}
      <div className="row">
        <span className="num">{index + 1}</span>
        <span className={`ico ${step.type === 'ai' ? 'ai' : ''}`}><Icon size={16} /></span>
        <div className="grow">
          <div className="title ellipsis" title={stepTitle(step)}>{stepTitle(step)}</div>
          {sel && <div className="mono muted ellipsis" title={sel}>{sel}</div>}
          {step.type === 'goto' && !sel && <div className="mono muted ellipsis">{step.url}</div>}
        </div>
        {step.optional && <span className="tag">optional</span>}
        {step.tip ? <span className="tag ai">tip</span> : null}
        {!readOnly && (
          <div className="acts">
            <button className="iconbtn" onClick={() => onMove?.(-1)} aria-label="Move up"><ArrowUp size={14} /></button>
            <button className="iconbtn" onClick={() => onMove?.(1)} aria-label="Move down"><ArrowDown size={14} /></button>
            {onSetRowStart && !rowStart && <button className="iconbtn" onClick={onSetRowStart} title="Repeat for each data row from this step" aria-label="Repeat from here"><Repeat1 size={14} /></button>}
            <button className="iconbtn" onClick={onRemove} aria-label="Delete step"><Trash2 size={14} /></button>
          </div>
        )}
      </div>

      {/* editable details */}
      {!readOnly && (step.type === 'type' || step.type === 'select') && (
        <div className="row" style={{ gap: 6 }}>
          <input className="input small grow" value={step.value ?? ''} onChange={(e) => set({ value: e.target.value })}
            placeholder="Value — supports {{account.username}}, {{today}}, {{row.col}}" type={step.secret && !String(step.value).includes('{{') ? 'password' : 'text'} />
          <ColumnPicker columns={columns} onPick={(tpl) => set({ value: tpl })} />
          <FormatPicker value={step.value ?? ''} onChange={(v) => set({ value: v })} />
        </div>
      )}
      {!readOnly && (step.type === 'type' || step.type === 'select') && !step.secret && <ValuePreview value={step.value} sampleRow={sampleRow} />}
      {!readOnly && step.type === 'check' && (
        <div className="row" style={{ gap: 6 }}>
          <select className="select small grow" value={['true', 'false'].includes(step.value || '') ? step.value : 'col'}
            onChange={(e) => e.target.value !== 'col' && set({ value: e.target.value })}>
            <option value="true">Always tick</option>
            <option value="false">Always untick</option>
            <option value="col" disabled={!/\{\{/.test(step.value || '')}>From column: {step.value}</option>
          </select>
          <ColumnPicker columns={columns} onPick={(tpl) => set({ value: tpl })} />
        </div>
      )}
      {!readOnly && step.type === 'check' && columns.length > 0 && (
        <div className="small muted">With a column: ticked when the cell is yes / x / 1 / true / oui, unticked otherwise.</div>
      )}
      {!readOnly && step.type === 'goto' && (
        <input className="input small mono" value={step.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
      )}
      {!readOnly && (step.type === 'extract_table' || step.type === 'extract_text') && (
        <input className="input small" value={step.name ?? ''} onChange={(e) => set({ name: e.target.value.replace(/\s+/g, '_') })} placeholder="Output name, e.g. orders" />
      )}
      {!readOnly && step.type === 'wait' && !step.target && (
        <input className="input small" type="number" min={100} step={100} value={step.ms ?? 1000} onChange={(e) => set({ ms: Number(e.target.value) })} />
      )}
      {!readOnly && step.type === 'pause' && (
        <>
          <input className="input small" value={step.value ?? ''} onChange={(e) => set({ value: e.target.value })}
            placeholder="What should you do? e.g. Enter the SMS code, then press Continue" />
          <label className="small row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!(step.condition && (step.condition as any).captcha)}
              onChange={(e) => set({ condition: e.target.checked ? { captcha: true } : undefined })} />
            Only when a CAPTCHA is on the page
          </label>
        </>
      )}
      {!readOnly && step.type === 'ai' && (
        <textarea className="textarea small" rows={2} value={step.instruction ?? ''} onChange={(e) => set({ instruction: e.target.value })}
          placeholder="What should the AI do here? e.g. 'Open the newest unread message and copy the sender'" />
      )}

      {step.type === 'extract_table' && step.target?.sample && step.target.sample.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="minitable">
            <thead><tr>{(step.target.columns || Object.keys(step.target.sample[0])).slice(0, 5).map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {step.target.sample.map((r, i) => (
                <tr key={i}>{(step.target!.columns || Object.keys(r)).slice(0, 5).map((c) => <td key={c}>{r[c]}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {step.rowCount ? <div className="small muted">{step.rowCount} rows on page</div> : null}
        </div>
      )}

      {readOnly && step.tip && <div className="small muted">Tip: {step.tip}</div>}
      {readOnly && step.loop && <div className="small mono muted">{JSON.stringify(step.loop)}</div>}
      {readOnly && step.condition && <div className="small mono muted">if {JSON.stringify(step.condition)}</div>}

      {!readOnly && step.type !== 'ai' && (
        <div className="row">
          <input className="input tipbox grow" value={step.tip ?? ''} onChange={(e) => set({ tip: e.target.value })}
            placeholder="Tip for AI (optional) — empty = just do this" />
          <label className="small muted row" style={{ gap: 4, flex: 'none' }} title="Skip instead of failing if this step can't be done">
            <input type="checkbox" checked={!!step.optional} onChange={(e) => set({ optional: e.target.checked })} /> opt.
          </label>
        </div>
      )}

      {!readOnly && onRepeatForItems && step.type === 'click' && step.in_list && (
        <button className="btn sm" style={{ justifyContent: 'flex-start', height: 'auto', padding: '6px 10px', whiteSpace: 'normal', textAlign: 'left' }} onClick={onRepeatForItems}
          title="The steps after this click run for every item of the list">
          <Repeat size={13} style={{ flex: 'none' }} /> This click opened item {step.in_list.index + 1} of {step.in_list.count} in a list. Repeat the next steps for every item
        </button>
      )}
      {step.type === 'loop' && step.loop?.over === 'items' && (
        <div className="small muted">
          Opens each item {step.loop.open === 'link' ? 'by its link' : 'by clicking its row on the list page'} and runs the steps below there.
          Results go to <b>{step.name}</b>{step.loop.from ? <> with the columns of <b>{step.loop.from}</b></> : null}.
          {!readOnly && onUndoRepeat && <> <button className="btn sm" style={{ height: 22 }} onClick={onUndoRepeat}>Undo</button></>}
        </div>
      )}
      {step.steps && step.steps.length > 0 && (
        <div className="children">
          {step.steps.map((c, i) => (
            <StepCard key={c.id || i} step={c} index={i} readOnly={readOnly} columns={columns} sampleRow={sampleRow}
              onChange={(n) => set({ steps: step.steps!.map((x, j) => (j === i ? n : x)) })}
              onRemove={() => set({ steps: step.steps!.filter((_, j) => j !== i) })}
              onMove={(d) => { const a = step.steps!.slice(); const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; set({ steps: a }); }} />
          ))}
        </div>
      )}
    </div>
  );
}
