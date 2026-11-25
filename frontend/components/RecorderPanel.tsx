'use client';
import { useState } from 'react';
import { Bot, Clock, Eraser, KeyRound, MousePointerClick, Sparkles, Table2, X, ScanText, Timer, Save, Circle } from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { patch, post } from '@/lib/api';
import type { Flow, Step } from '@/lib/types';
import { uid } from '@/lib/steps';
import { StepCard } from './StepCard';
import { BuildWithAI } from './BuildWithAI';
import type { AppCtx } from './Shell';

export function RecorderPanel({ ctx, rec, steps, setSteps, editingFlow, setEditingFlow, onClose }: {
  ctx: AppCtx;
  rec: { recording: boolean; mode?: string };
  steps: Step[];
  setSteps: React.Dispatch<React.SetStateAction<Step[]>>;
  editingFlow: Flow | null;
  setEditingFlow: (f: Flow | null) => void;
  onClose: () => void;
}) {
  const b = bridge();
  const [name, setName] = useState(editingFlow?.name || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [buildFlow, setBuildFlow] = useState<Flow | null>(null);

  const mode = rec.recording ? rec.mode || 'record' : 'off';
  const setMode = (m: string) => b.recorder.setMode(mode === m ? 'record' : m);

  const update = (i: number, s: Step) => setSteps((cur) => cur.map((x, j) => (j === i ? s : x)));
  const remove = (i: number) => setSteps((cur) => cur.filter((_, j) => j !== i));
  const move = (i: number, d: -1 | 1) => setSteps((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const n = cur.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const add = (s: Partial<Step>) => setSteps((cur) => [...cur, { id: uid(), ts: Date.now(), ...s } as Step]);

  const startUrl = () => steps.find((s) => s.type === 'goto')?.url || ctx.activeTab?.url || '';

  const save = async (build: boolean) => {
    if (!steps.length) { ctx.toast('Record some steps first', true); return; }
    const flowName = name.trim() || `Flow on ${(() => { try { return new URL(startUrl()).host; } catch { return 'site'; } })()}`;
    setBusy(build ? 'build' : 'save');
    try {
      if (rec.recording) await b.recorder.stop();
      const body = { name: flowName, start_url: startUrl(), steps };
      let flow: Flow = editingFlow ? await patch(`/flows/${editingFlow.id}`, body) : await post('/flows', body);
      setEditingFlow(flow);
      ctx.toast(`Saved "${flow.name}"`);
      await ctx.reloadFlows();
      // ask for the goal next, then let the AI build + review
      if (build) setBuildFlow(flow);
    } catch (e: any) {
      ctx.toast(e.message, true);
    } finally { setBusy(null); }
  };

  const clear = () => {
    if (steps.length && !confirm('Clear all recorded steps?')) return;
    setSteps([]); setEditingFlow(null); setName('');
  };

  if (buildFlow) {
    return (
      <BuildWithAI ctx={ctx} flow={buildFlow}
        onCancel={() => setBuildFlow(null)}
        onRecordMore={(f) => { setEditingFlow(f); setBuildFlow(null); if (ctx.activeTab?.url) b.recorder.start(ctx.activeTab.id); }}
        onDone={(f) => { setBuildFlow(null); ctx.openFlow(f.id); }} />
    );
  }

  return (
    <>
      <header>
        <h2>{editingFlow ? `Editing: ${editingFlow.name}` : 'Recorder'}</h2>
        {rec.recording && <span className="tag err"><Circle size={8} fill="currentColor" /> REC</span>}
        <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="body">
        {!rec.recording ? (
          <div className="card">
            <div className="small muted">
              Open a website, press <b>Record</b>, then use the site normally. Every click and form fill becomes a step.
              Leave a step&apos;s tip empty to repeat it exactly, or write a tip (e.g. <i>“do this for every row”</i>,
              <i> “pick the newest order”</i>) so the AI can generalise it.
            </div>
            <button className="btn primary" onClick={() => ctx.activeTab?.url ? b.recorder.start(ctx.activeTab.id) : ctx.toast('Open a website first', true)}>
              <Circle size={12} fill="currentColor" /> {steps.length ? 'Continue recording' : 'Start recording this tab'}
            </button>
          </div>
        ) : (
          <>
            <div className="section">Capture</div>
            <div className="toolgrid">
              <button className={`tool ${mode === 'record' ? 'on' : ''}`} onClick={() => b.recorder.setMode('record')}><MousePointerClick size={18} />Clicks & typing</button>
              <button className={`tool ${mode === 'pick-table' ? 'on' : ''}`} onClick={() => setMode('pick-table')}><Table2 size={18} />Pick table</button>
              <button className={`tool ${mode === 'pick-text' ? 'on' : ''}`} onClick={() => setMode('pick-text')}><ScanText size={18} />Pick text</button>
              <button className={`tool ${mode === 'pick-wait' ? 'on' : ''}`} onClick={() => setMode('pick-wait')}><Clock size={18} />Wait for…</button>
              <button className="tool" onClick={() => add({ type: 'wait', ms: 2000 })}><Timer size={18} />Pause 2s</button>
              <button className="tool" onClick={() => add({ type: 'ai', instruction: '' })}><Bot size={18} />AI step</button>
            </div>
            <button className="btn sm" onClick={() => add({ type: 'login' })} title="Fills username / password / 2FA from the account the flow runs as">
              <KeyRound size={14} /> Add “log in with saved account” step
            </button>
            {mode.startsWith('pick-') && <div className="small muted">Hover the page — the highlighted element is what you&apos;ll get. Click to capture.</div>}
          </>
        )}

        <div className="section">Steps ({steps.length})</div>
        {steps.length === 0 ? (
          <div className="empty"><div className="big"><MousePointerClick size={26} /></div>No steps yet.</div>
        ) : (
          steps.map((s, i) => (
            <StepCard key={s.id} step={s} index={i} onChange={(n) => update(i, n)} onRemove={() => remove(i)} onMove={(d) => move(i, d)} />
          ))
        )}
      </div>
      <footer>
        <input className="input" placeholder="Flow name, e.g. Export invoices" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="row">
          <button className="btn" onClick={clear} title="Clear"><Eraser size={14} /></button>
          <button className="btn grow" disabled={!!busy} onClick={() => save(false)}><Save size={14} />{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="btn primary grow" disabled={!!busy} onClick={() => save(true)}>
            <Sparkles size={14} />{busy === 'build' ? 'Saving…' : 'Save & build with AI'}
          </button>
        </div>
      </footer>
    </>
  );
}
