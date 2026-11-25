'use client';
import { useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Database, Loader2, MousePointerClick, Sparkles, Wand2, X,
} from 'lucide-react';
import { post } from '@/lib/api';
import type { Flow, OutputKind } from '@/lib/types';
import { hostPath } from '@/lib/steps';
import { StepCard } from './StepCard';
import type { AppCtx } from './Shell';

const EXAMPLES = [
  'Scrape every product name, price and stock status from all pages into a CSV',
  'Log in to each of my accounts and download this month’s invoices',
  'Fill this form once for every row of my list',
  'Every day, check new orders and mark them as shipped',
];

const KINDS: { id: OutputKind; label: string; hint: string }[] = [
  { id: 'data', label: 'Get data', hint: 'scrape / export' },
  { id: 'action', label: 'Do something', hint: 'click, submit, update' },
  { id: 'both', label: 'Both', hint: '' },
];

type Stage = 'goal' | 'building' | 'review';

/**
 * Asks why the flow was recorded, lets Claude build it from recording + goal,
 * then shows what it understood, gaps, the output it will produce, and opt-in
 * suggestions that can be applied with one click (refine loop).
 */
export function BuildWithAI({ ctx, flow: initial, onDone, onCancel, onRecordMore }: {
  ctx: AppCtx;
  flow: Flow;
  onDone: (f: Flow) => void;
  onCancel: () => void;
  onRecordMore?: (f: Flow) => void;
}) {
  const [flow, setFlow] = useState<Flow>(initial);
  const [stage, setStage] = useState<Stage>('goal');
  const recordedColumns = useMemo(
    () => initial.steps.flatMap((s) => (s.type === 'extract_table' ? s.target?.columns || [] : s.type === 'extract_text' && s.name ? [s.name] : [])),
    [initial.steps],
  );
  const [goal, setGoal] = useState(initial.description || initial.compiled?.goal || '');
  const [kind, setKind] = useState<OutputKind>(initial.compiled?.output_kind || (recordedColumns.length ? 'data' : 'action'));
  const [fields, setFields] = useState(
    (initial.compiled?.output_fields?.map((f) => f.name) || recordedColumns).join(', '),
  );
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [showSteps, setShowSteps] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c = flow.compiled;
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    initial.steps.forEach((s) => { m[s.type] = (m[s.type] || 0) + 1; });
    return m;
  }, [initial.steps]);

  const run = async (body: Record<string, unknown>) => {
    if (!ctx.settings?.has_api_key) {
      ctx.toast('Add your Anthropic API key in Settings first', true);
      ctx.openPanel('settings');
      return;
    }
    setError(null);
    setStage('building');
    try {
      const updated = await post<Flow>(`/flows/${flow.id}/compile`, body);
      setFlow(updated);
      setPicked(new Set());
      setFeedback('');
      setStage('review');
      ctx.reloadFlows();
    } catch (e: any) {
      setError(e.message);
      setStage(flow.compiled ? 'review' : 'goal');
    }
  };

  const build = () => {
    if (!goal.trim()) { setError('Tell the AI what you are trying to do.'); return; }
    run({
      goal: goal.trim(),
      output_kind: kind,
      output_fields: kind === 'action' ? [] : fields.split(',').map((f) => f.trim()).filter(Boolean),
    });
  };

  const refine = () => {
    const chosen = (c?.suggestions || []).filter((_, i) => picked.has(i)).map((s) => `- ${s.instruction}`);
    const text = [...chosen, feedback.trim()].filter(Boolean).join('\n');
    if (!text) return;
    run({ feedback: text });
  };

  // ------------------------------------------------------------------ goal
  if (stage === 'goal') {
    return (
      <>
        <header>
          <button className="iconbtn" onClick={onCancel} aria-label="Back"><ArrowLeft size={18} /></button>
          <h2>Build with AI</h2>
          <Sparkles size={18} color="var(--accent)" />
        </header>
        <div className="body">
          <div className="card compact">
            <div className="small muted">
              You recorded <b>{initial.steps.length} steps</b> on <b>{hostPath(initial.start_url || '') || 'this site'}</b>
            </div>
            <div className="row wrap" style={{ gap: 4 }}>
              {Object.entries(counts).map(([t, n]) => <span key={t} className="tag">{n}× {t.replace('_', ' ')}</span>)}
            </div>
          </div>

          <label className="label" style={{ fontSize: 13, color: 'var(--ink)' }}>
            What are you trying to do?
            <textarea className="textarea" rows={5} autoFocus value={goal} onChange={(e) => setGoal(e.target.value)}
              placeholder="Explain the whole idea in your own words: what this is for, what should happen, for which pages / rows / accounts, and what you want at the end." />
          </label>
          {!goal && (
            <div className="row wrap" style={{ gap: 6 }}>
              {EXAMPLES.map((ex) => (
                <button key={ex} className="btn sm" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => setGoal(ex)}>{ex}</button>
              ))}
            </div>
          )}

          <div className="section">What should it give you?</div>
          <div className="segmented">
            {KINDS.map((k) => (
              <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)} title={k.hint}>{k.label}</button>
            ))}
          </div>
          {kind !== 'action' && (
            <label className="label">
              Fields you want in the result (optional, comma separated)
              <input className="input" value={fields} onChange={(e) => setFields(e.target.value)} placeholder="e.g. name, price, url, stock" />
            </label>
          )}
          {error && <div className="card compact small row" style={{ color: 'var(--rec)' }}><AlertTriangle size={14} />{error}</div>}
        </div>
        <footer>
          {c?.understanding && <button className="btn" onClick={() => setStage('review')}>See last build</button>}
          <button className="btn primary block" onClick={build}><Wand2 size={15} /> Build automation</button>
          <div className="small muted" style={{ textAlign: 'center' }}>Passwords and 2FA codes are never sent to the AI.</div>
        </footer>
      </>
    );
  }

  // ------------------------------------------------------------------ building
  if (stage === 'building') {
    return (
      <>
        <header><h2>Build with AI</h2></header>
        <div className="body">
          <div className="empty" style={{ paddingTop: 80 }}>
            <div className="big"><Loader2 size={26} className="spin" /></div>
            <b style={{ color: 'var(--ink)' }}>Claude is reading your recording…</b>
            Comparing it with your goal, generalising steps and planning the output. This can take up to a minute.
          </div>
        </div>
      </>
    );
  }

  // ------------------------------------------------------------------ review
  const suggestions = c?.suggestions || [];
  const gaps = c?.gaps || [];
  return (
    <>
      <header>
        <button className="iconbtn" onClick={() => setStage('goal')} aria-label="Edit goal"><ArrowLeft size={18} /></button>
        <h2>AI review</h2>
        <button className="iconbtn" onClick={() => onDone(flow)} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="body">
        <div className="card">
          <div className="row">
            <Sparkles size={16} color="var(--accent)" />
            <div className="title grow">What I understood</div>
            {c?.matches_goal
              ? <span className="tag ok"><Check size={11} /> matches your goal</span>
              : <span className="tag warn"><AlertTriangle size={11} /> recording incomplete</span>}
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.5, userSelect: 'text' }}>{c?.understanding || c?.summary}</div>
          {c?.goal && <div className="small muted">Your goal: “{c.goal}”</div>}
        </div>

        {gaps.length > 0 && (
          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' }}>
            <div className="row"><AlertTriangle size={15} color="var(--warn)" /><div className="title grow">I need a bit more from you</div></div>
            {gaps.map((g, i) => <div key={i} className="small row" style={{ alignItems: 'flex-start' }}><span className="muted">•</span><span>{g}</span></div>)}
            {onRecordMore && (
              <button className="btn sm" onClick={() => onRecordMore(flow)}><MousePointerClick size={13} /> Record the missing part</button>
            )}
          </div>
        )}

        <div className="card">
          <div className="row">
            <Database size={15} color="var(--accent)" />
            <div className="title grow">Output</div>
            <span className="tag">{c?.output_kind === 'action' ? 'action' : c?.output_kind === 'both' ? 'data + action' : 'data'}</span>
          </div>
          {(c?.output_fields || []).length ? (
            <div className="row wrap" style={{ gap: 6 }}>
              {c!.output_fields!.map((f) => <span key={f.name} className="tag ai" title={f.description}>{f.name}</span>)}
            </div>
          ) : <div className="small muted">No data is collected; the run reports success or failure.</div>}
          <div className="small muted">Results appear under Runs and export to CSV / JSON.</div>
        </div>

        {suggestions.length > 0 && (
          <>
            <div className="section">Suggestions — pick any to apply</div>
            {suggestions.map((s, i) => {
              const on = picked.has(i);
              return (
                <button key={i} className={`card compact ${on ? 'sel' : ''}`} style={{ textAlign: 'left' }}
                  onClick={() => setPicked((cur) => { const n = new Set(cur); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    {on ? <CheckCircle2 size={18} color="var(--accent)" /> : <Circle size={18} className="muted" />}
                    <div className="grow">
                      <div className="title">{s.title}</div>
                      <div className="small muted">{s.detail}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </>
        )}

        <label className="label">
          Anything to change? Tell the AI
          <textarea className="textarea" rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. only orders from the last 7 days, skip cancelled ones, also save the order link" />
        </label>
        {error && <div className="card compact small row" style={{ color: 'var(--rec)' }}><AlertTriangle size={14} />{error}</div>}

        <button className="row btn sm" style={{ justifyContent: 'flex-start' }} onClick={() => setShowSteps((v) => !v)}>
          {showSteps ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Built steps ({c?.steps.length || 0})
        </button>
        {showSteps && c?.steps.map((s, i) => <StepCard key={s.id || i} step={s} index={i} readOnly />)}
        {c?.warnings?.map((w, i) => <div key={i} className="small row" style={{ color: 'var(--warn)' }}><AlertTriangle size={12} />{w}</div>)}
      </div>
      <footer>
        <div className="row">
          <button className="btn grow" disabled={!picked.size && !feedback.trim()} onClick={refine}>
            <Wand2 size={14} /> Apply{picked.size ? ` ${picked.size}` : ''} & rebuild
          </button>
          <button className="btn primary grow" onClick={() => onDone(flow)}><Check size={14} /> Looks good</button>
        </div>
      </footer>
    </>
  );
}
