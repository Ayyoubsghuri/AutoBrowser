'use client';
import {
  ArrowDown, ArrowUp, Bot, Clock, Globe, Keyboard, KeyRound, List, MousePointerClick, Repeat, ScrollText, Table2, Trash2, Type, GitBranch, ChevronDown, ScanText,
} from 'lucide-react';
import type { Step } from '@/lib/types';
import { bestSelector, stepTitle } from '@/lib/steps';

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  goto: Globe, click: MousePointerClick, type: Type, select: ChevronDown, press: Keyboard, scroll: ScrollText,
  wait: Clock, extract_table: Table2, extract_text: ScanText, login: KeyRound, loop: Repeat, if: GitBranch, ai: Bot,
};

export function StepCard({ step, index, onChange, onRemove, onMove, readOnly = false }: {
  step: Step; index: number;
  onChange?: (s: Step) => void; onRemove?: () => void; onMove?: (dir: -1 | 1) => void; readOnly?: boolean;
}) {
  const Icon = ICONS[step.type] || List;
  const set = (patch: Partial<Step>) => onChange?.({ ...step, ...patch });
  const sel = bestSelector(step);
  return (
    <div className="card compact step">
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
            <button className="iconbtn" onClick={onRemove} aria-label="Delete step"><Trash2 size={14} /></button>
          </div>
        )}
      </div>

      {/* editable details */}
      {!readOnly && (step.type === 'type' || step.type === 'select') && (
        <input className="input small" value={step.value ?? ''} onChange={(e) => set({ value: e.target.value })}
          placeholder="Value — supports {{account.username}}, {{today}}, {{row.col}}" type={step.secret && !String(step.value).includes('{{') ? 'password' : 'text'} />
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

      {step.steps && step.steps.length > 0 && (
        <div className="children">
          {step.steps.map((c, i) => <StepCard key={c.id || i} step={c} index={i} readOnly />)}
        </div>
      )}
    </div>
  );
}
