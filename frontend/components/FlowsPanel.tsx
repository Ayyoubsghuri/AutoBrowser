'use client';
import { useEffect, useMemo, useState } from 'react';
import { Download, Pencil, Play, Sparkles, Square, Trash2, Upload, Workflow, X, ChevronLeft, AlertTriangle } from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { del, post } from '@/lib/api';
import type { Flow, RunMode } from '@/lib/types';
import { hostPath } from '@/lib/steps';
import { StepCard } from './StepCard';
import type { AppCtx } from './Shell';

const MODES: { id: RunMode; label: string; hint: string }[] = [
  { id: 'exact', label: 'Exact', hint: 'Replays your recording step by step. No AI, no API key, free.' },
  { id: 'assist', label: 'AI assist', hint: 'Recording, but steps with a tip are done by the AI, and broken selectors are re-found by AI.' },
  { id: 'compiled', label: 'AI-built', hint: 'Runs the version the AI built from your recording + tips (loops, login, pagination).' },
];

export function FlowsPanel({ ctx, onClose, onEdit }: { ctx: AppCtx; onClose: () => void; onEdit: (f: Flow) => void }) {
  const b = bridge();
  const [selId, setSelId] = useState<string | null>(null);
  const [mode, setMode] = useState<RunMode>('exact');
  const [accounts, setAccounts] = useState<(string | null)[]>([]);
  const [parallel, setParallel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<'recorded' | 'compiled'>('recorded');
  useEffect(() => { ctx.reloadFlows(); ctx.reloadProfiles(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const flow = useMemo(() => ctx.flows.find((f) => f.id === selId) || null, [ctx.flows, selId]);

  const toggleAcc = (id: string | null) => setAccounts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const run = async () => {
    if (!flow) return;
    if (mode !== 'exact' && !ctx.settings?.has_api_key) { ctx.toast('This mode needs an Anthropic API key (Settings)', true); return; }
    if (mode === 'compiled' && !flow.compiled) { ctx.toast('Build with AI first', true); return; }
    setBusy('run');
    ctx.openPanel('runs');
    try { await b.runner.run({ flow, profileIds: accounts.length ? accounts : [null], mode, parallel }); }
    catch (e: any) { ctx.toast(e.message, true); }
    finally { setBusy(null); }
  };

  const build = async () => {
    if (!flow) return;
    if (!ctx.settings?.has_api_key) { ctx.toast('Add an Anthropic API key in Settings first', true); ctx.openPanel('settings'); return; }
    setBusy('build');
    try { await post(`/flows/${flow.id}/compile`); await ctx.reloadFlows(); setView('compiled'); ctx.toast('AI built the automation ✓'); }
    catch (e: any) { ctx.toast(e.message, true); }
    finally { setBusy(null); }
  };

  const remove = async () => {
    if (!flow || !confirm(`Delete "${flow.name}"?`)) return;
    await del(`/flows/${flow.id}`); setSelId(null); ctx.reloadFlows();
  };

  const exportFlow = async () => {
    if (!flow) return;
    const { id, created, updated, ...rest } = flow;
    await b.saveFile({ name: `${flow.name.replace(/[^\w-]+/g, '_')}.autobrowser.json`, content: JSON.stringify(rest, null, 2) });
  };

  const importFlow = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const created = await post<Flow>('/flows', { name: data.name || f.name, start_url: data.start_url, description: data.description, steps: data.steps || [], compiled: data.compiled || null });
        await ctx.reloadFlows(); setSelId(created.id); ctx.toast('Imported');
      } catch (e: any) { ctx.toast(`Import failed: ${e.message}`, true); }
    };
    inp.click();
  };

  if (!flow) {
    return (
      <>
        <header>
          <h2>Saved flows</h2>
          <button className="iconbtn" onClick={importFlow} title="Import flow JSON" aria-label="Import"><Upload size={16} /></button>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="body">
          {ctx.flows.length === 0 && (
            <div className="empty"><div className="big"><Workflow size={26} /></div>No flows yet. Record one with the red Record button.</div>
          )}
          {ctx.flows.map((f) => (
            <button key={f.id} className="card compact" style={{ textAlign: 'left' }} onClick={() => { setSelId(f.id); setView(f.compiled ? 'compiled' : 'recorded'); setMode(f.compiled ? 'compiled' : 'exact'); }}>
              <div className="row">
                <Workflow size={16} color="var(--accent)" />
                <div className="grow">
                  <div className="title ellipsis">{f.name}</div>
                  <div className="small muted ellipsis">{hostPath(f.start_url || '')} · {f.steps.length} steps</div>
                </div>
                {f.compiled ? <span className="tag ai">AI-built</span> : <span className="tag">recorded</span>}
              </div>
            </button>
          ))}
        </div>
      </>
    );
  }

  const shown = view === 'compiled' && flow.compiled ? flow.compiled.steps : flow.steps;
  return (
    <>
      <header>
        <button className="iconbtn" onClick={() => setSelId(null)} aria-label="Back"><ChevronLeft size={18} /></button>
        <h2 className="ellipsis">{flow.name}</h2>
        <button className="iconbtn" onClick={() => onEdit(flow)} title="Edit recording" aria-label="Edit"><Pencil size={15} /></button>
        <button className="iconbtn" onClick={exportFlow} title="Export" aria-label="Export"><Download size={15} /></button>
        <button className="iconbtn" onClick={remove} title="Delete" aria-label="Delete"><Trash2 size={15} /></button>
      </header>
      <div className="body">
        <div className="card">
          <div className="section" style={{ margin: 0 }}>Run as</div>
          <div className="row wrap">
            <button className={`check ${accounts.includes(null) ? 'on' : ''}`} onClick={() => toggleAcc(null)}>Default profile</button>
            {ctx.profiles.map((p) => (
              <button key={p.id} className={`check ${accounts.includes(p.id) ? 'on' : ''}`} onClick={() => toggleAcc(p.id)}>
                <span className="dot" style={{ background: p.color }} />{p.name}
              </button>
            ))}
          </div>
          {accounts.length > 1 && (
            <label className="small row"><input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} /> Run accounts in parallel tabs</label>
          )}
          <div className="segmented">
            {MODES.map((m) => (
              <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)} disabled={m.id === 'compiled' && !flow.compiled}>{m.label}</button>
            ))}
          </div>
          <div className="small muted">{MODES.find((m) => m.id === mode)?.hint}</div>
          <div className="row">
            <button className="btn primary grow" onClick={run} disabled={busy === 'run'}><Play size={14} />{busy === 'run' ? 'Running…' : `Run${accounts.length > 1 ? ` × ${accounts.length}` : ''}`}</button>
            {busy === 'run' && <button className="btn" onClick={() => b.runner.stop()}><Square size={12} /> Stop</button>}
          </div>
        </div>

        <div className="card">
          <div className="row">
            <Sparkles size={16} color="var(--accent)" />
            <div className="grow title">AI build</div>
            <button className="btn sm" onClick={build} disabled={busy === 'build'}>{busy === 'build' ? 'Building…' : flow.compiled ? 'Rebuild' : 'Build with AI'}</button>
          </div>
          {flow.compiled ? (
            <>
              <div className="small">{flow.compiled.summary}</div>
              {flow.compiled.warnings?.map((w, i) => <div key={i} className="small row" style={{ color: 'var(--warn)' }}><AlertTriangle size={12} />{w}</div>)}
            </>
          ) : (
            <div className="small muted">Turns your recording + tips into a robust automation (loops over rows, pagination, login, variables). Runs without AI afterwards unless it contains AI steps.</div>
          )}
        </div>

        <div className="row">
          <div className="section grow">Steps</div>
          {flow.compiled && (
            <div className="segmented" style={{ width: 200 }}>
              <button className={view === 'recorded' ? 'on' : ''} onClick={() => setView('recorded')}>Recorded</button>
              <button className={view === 'compiled' ? 'on' : ''} onClick={() => setView('compiled')}>AI-built</button>
            </div>
          )}
        </div>
        {shown.map((s, i) => <StepCard key={s.id || i} step={s} index={i} readOnly />)}
      </div>
    </>
  );
}
