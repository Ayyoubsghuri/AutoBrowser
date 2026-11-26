'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bot, Circle, Cog, History, Home, Lock, Plus, RotateCw, Square, UserRound, Workflow, X, Loader2, Search,
  FileSpreadsheet, Hand,
} from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { get } from '@/lib/api';
import type { Dataset, Flow, Profile, RunLog, RunPause, RunProgress, Settings, Step, TabInfo } from '@/lib/types';
import { matchColumn, shouldAddGoto, uid } from '@/lib/steps';
import { StartPage } from './StartPage';
import { RecorderPanel } from './RecorderPanel';
import { FlowsPanel } from './FlowsPanel';
import { AccountsPanel } from './AccountsPanel';
import { RunsPanel } from './RunsPanel';
import { SettingsPanel } from './SettingsPanel';
import { DataPanel } from './DataPanel';

export type PanelId = 'recorder' | 'flows' | 'accounts' | 'data' | 'runs' | 'settings' | null;

/** Data attached while recording: typed values equal to a cell of `row` become {{row.<column>}}. */
export type RecData = { dataset: Dataset; rowIndex: number } | null;

export type AppCtx = {
  profiles: Profile[];
  flows: Flow[];
  settings: Settings | null;
  reloadProfiles: () => Promise<void>;
  reloadFlows: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  toast: (msg: string, error?: boolean) => void;
  openPanel: (p: PanelId) => void;
  openFlow: (id: string) => void;
  focusFlowId: string | null;
  activeTab: TabInfo | null;
};

const DRAFT_KEY = 'ab.recorder.draft';

export default function Shell() {
  const b = bridge();
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [panel, setPanel] = useState<PanelId>(null);
  const [address, setAddress] = useState('');
  const [editingAddr, setEditingAddr] = useState(false);
  const [rec, setRec] = useState<{ recording: boolean; mode?: string; profileId?: string | null }>({ recording: false });
  const [steps, setSteps] = useState<Step[]>([]);
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [focusFlowId, setFocusFlowId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, RunProgress>>({});
  const [pauses, setPauses] = useState<RunPause[]>([]);
  const [recData, setRecData] = useState<RecData>(null);
  const recRowRef = useRef<Record<string, unknown> | null>(null);
  recRowRef.current = recData ? recData.dataset.rows[recData.rowIndex] || null : null;
  const [toastMsg, setToastMsg] = useState<{ msg: string; error?: boolean } | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const addrRef = useRef<HTMLInputElement>(null);
  const stepsRef = useRef<Step[]>([]);
  stepsRef.current = steps;

  const activeTab = tabs.find((t) => t.id === activeId) || null;
  const showStart = !activeTab || !activeTab.url;
  const inFirefox = !!activeTab && activeTab.engine === 'firefox' && !showStart;

  const toast = useCallback((msg: string, error = false) => {
    setToastMsg({ msg, error });
    window.setTimeout(() => setToastMsg((m) => (m && m.msg === msg ? null : m)), 3800);
  }, []);

  const reloadProfiles = useCallback(async () => {
    try { setProfiles(await get<Profile[]>('/profiles')); await b.profiles.refresh(); } catch (e: any) { setBackendError(e.message); }
  }, [b]);
  const reloadFlows = useCallback(async () => {
    try { setFlows(await get<Flow[]>('/flows')); } catch (e: any) { setBackendError(e.message); }
  }, []);
  const reloadSettings = useCallback(async () => {
    try { setSettings(await get<Settings>('/settings')); await b.settings.refresh(); } catch (e: any) { setBackendError(e.message); }
  }, [b]);

  // ------------------------------------------------------------ wiring
  useEffect(() => {
    reloadProfiles(); reloadFlows(); reloadSettings();
    b.tabs.list().then(({ tabs, activeTabId }) => { setTabs(tabs); setActiveId(activeTabId); });
    try {
      const d = localStorage.getItem(DRAFT_KEY);
      if (d) setSteps(JSON.parse(d));
    } catch {}
    const offs = [
      b.on('tabs:update', ({ tabs, activeTabId }) => { setTabs(tabs); setActiveId(activeTabId); }),
      b.on('tabs:error', ({ desc, url }) => toast(`Could not load ${url}: ${desc}`, true)),
      b.on('rec:state', (s) => {
        setRec(s);
        if (s.recording && s.url !== undefined) {
          // fresh recording: start with the page we're on
          setSteps((cur) => (cur.length || !s.url ? cur : [{ id: uid(), type: 'goto', url: s.url, ts: Date.now() }]));
        }
      }),
      b.on('rec:step', (step: Step & { type: string; message?: string }) => {
        if ((step as any).type === 'notice') { toast((step as any).message); return; }
        const s: Step = { ...step, id: uid(), tip: '' };
        // typed a value from the data row you are recording with? -> make it {{row.<column>}}
        const tpl = (s.type === 'type' || s.type === 'select') && !s.secret
          ? matchColumn(s.value, recRowRef.current) || (s.type === 'select' ? matchColumn(s.label, recRowRef.current) : null)
          : null;
        if (tpl) { s.sample = s.value; s.value = tpl; }
        setSteps((cur) => [...cur, s]);
      }),
      b.on('rec:navigated', ({ url, ts }) => {
        setSteps((cur) => (shouldAddGoto(cur, url, ts) ? [...cur, { id: uid(), type: 'goto', url, ts }] : cur));
      }),
      b.on('run:log', (l: RunLog) => setLogs((cur) => [...cur.slice(-800), l])),
      b.on('run:progress', (p: RunProgress) => setProgress((cur) => ({ ...cur, [p.runId]: p }))),
      b.on('run:paused', (p: RunPause) => setPauses((cur) => [...cur.filter((x) => x.runId !== p.runId), p])),
      b.on('run:resumed', ({ runId }) => setPauses((cur) => cur.filter((x) => x.runId !== runId))),
      b.on('run:status', ({ runId, status }) => {
        setRunning((cur) => ({ ...cur, [runId]: status }));
        if (status !== 'running') setPauses((cur) => cur.filter((x) => x.runId !== runId));
        if (status === 'success') toast('Run finished ✓');
        if (status === 'failed') toast('Run failed — see Runs', true);
      }),
      b.on('ui:focus-address', () => { addrRef.current?.focus(); addrRef.current?.select(); }),
      b.on('ui:new-tab', () => b.tabs.create({ profileId: null })),
      b.on('download:done', ({ file, state }) => state === 'completed' && toast(`Downloaded ${file}`)),
    ];
    return () => offs.forEach((o) => o());
  }, [b, reloadFlows, reloadProfiles, reloadSettings, toast]);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(steps)); } catch {}
  }, [steps]);

  useEffect(() => { if (!editingAddr) setAddress(activeTab?.url || ''); }, [activeTab?.url, editingAddr]);

  // keep the native page view glued to the frame rectangle
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const send = () => {
      if (showStart || inFirefox) { b.setPageBounds(null); return; }
      const r = el.getBoundingClientRect();
      b.setPageBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener('resize', send);
    return () => { ro.disconnect(); window.removeEventListener('resize', send); };
  }, [b, showStart, inFirefox, panel]);

  // ------------------------------------------------------------ actions
  const navigate = (input: string) => {
    if (!input.trim()) return;
    if (activeId == null) b.tabs.create({ url: input });
    else b.tabs.navigate(activeId, input);
    setEditingAddr(false);
    addrRef.current?.blur();
  };

  const toggleRecording = async () => {
    if (rec.recording) { await b.recorder.stop(); return; }
    if (showStart) { toast('Open a website first, then press Record.', true); return; }
    setPanel('recorder');
    await b.recorder.start(activeId);
  };

  const ctx: AppCtx = {
    profiles, flows, settings, reloadProfiles, reloadFlows, reloadSettings, toast, openPanel: setPanel, activeTab,
    focusFlowId, openFlow: (id: string) => { setFocusFlowId(id); setPanel('flows'); },
  };
  const profileOf = (id: string | null | undefined) => profiles.find((p) => p.id === id);
  const runningCount = Object.values(running).filter((s) => s === 'running').length;
  const isSecure = activeTab?.url?.startsWith('https://');

  const RailBtn = ({ id, icon, tip, badge }: { id: Exclude<PanelId, null>; icon: React.ReactNode; tip: string; badge?: number }) => (
    <button className={`railbtn ${panel === id ? 'active' : ''} ${id === 'recorder' ? 'rec' : ''}`} data-tip={tip}
      onClick={() => { if (id === 'flows') setFocusFlowId(null); setPanel(panel === id ? null : id); }} aria-label={tip}>
      {icon}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );

  return (
    <>
      <div className="wallpaper" aria-hidden><i className="b6" /><i className="b5" /><i className="b3" /><i className="b4" /><i className="b1" /><i className="b2" /></div>
      <div className="shell">
        <div className="brand drag"><div className="logo" title="AutoBrowser" /></div>

        {/* ---------------------------------------------- tabs */}
        <div className="tabsbar drag">
          {tabs.map((t) => {
            const p = profileOf(t.profileId);
            return (
              <div key={t.id} className={`tab nodrag ${t.id === activeId ? 'active' : ''}`} onMouseDown={() => b.tabs.activate(t.id)} role="tab">
                {t.loading ? <Loader2 size={14} className="spin" /> : t.favicon ? <img className="fav" src={t.favicon} alt="" /> : <Circle size={14} />}
                <span className="t">{t.title || 'New tab'}</span>
                {t.engine === 'firefox' && <span className="tag" style={{ height: 16, padding: '0 5px', fontSize: 10 }} title="Open in the Firefox window">FF</span>}
                {p && <span className="dot" style={{ background: p.color }} title={p.name} />}
                <button className="x" onMouseDown={(e) => { e.stopPropagation(); b.tabs.close(t.id); }} aria-label="Close tab"><X size={13} /></button>
              </div>
            );
          })}
          <button className="iconbtn nodrag" onClick={() => b.tabs.create({ profileId: activeTab?.profileId ?? null })} aria-label="New tab"><Plus size={18} /></button>
        </div>

        {/* ---------------------------------------------- nav row */}
        <div className="navrow">
          <div className="navgroup glass pill">
            <button className="iconbtn" disabled={!activeTab?.canGoBack} onClick={() => b.tabs.back()} aria-label="Back"><ArrowLeft size={18} /></button>
            <button className="iconbtn" disabled={!activeTab?.canGoForward} onClick={() => b.tabs.forward()} aria-label="Forward"><ArrowRight size={18} /></button>
            <button className="iconbtn" onClick={() => b.tabs.reload()} aria-label="Reload"><RotateCw size={16} /></button>
          </div>
          <form className="address glass pill" onSubmit={(e) => { e.preventDefault(); navigate(address); }}>
            {isSecure ? <Lock size={15} className="muted" /> : <Search size={15} className="muted" />}
            <input ref={addrRef} value={address} placeholder="Search the web or type an address here" spellCheck={false}
              onFocus={(e) => { setEditingAddr(true); e.target.select(); }} onBlur={() => setEditingAddr(false)}
              onChange={(e) => setAddress(e.target.value)} />
            <label className="chip" title="Account / browser profile for this tab. Each one keeps its own cookies and logins.">
              {profileOf(activeTab?.profileId) ? <span className="dot" style={{ background: profileOf(activeTab?.profileId)!.color }} /> : <UserRound size={14} />}
              <select className="nodrag" style={{ border: 0, background: 'transparent', outline: 0, maxWidth: 140 }}
                value={activeTab?.profileId || ''} onChange={(e) => b.tabs.setProfile(activeId, e.target.value || null)}>
                <option value="">Default profile</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </form>
          <button className={`recbtn glass pill ${rec.recording ? 'live' : ''}`} onClick={toggleRecording}>
            {rec.recording ? <Square size={14} fill="currentColor" /> : <span className="rdot" />}
            {rec.recording ? 'Stop' : 'Record'}
          </button>
        </div>

        {/* ---------------------------------------------- rail */}
        <nav className="rail">
          <div className="railgroup glass">
            <button className="railbtn" data-tip="New tab" onClick={() => b.tabs.create({ profileId: activeTab?.profileId ?? null })} aria-label="New tab"><Home size={20} /></button>
            <RailBtn id="recorder" icon={<Circle size={20} />} tip="Recorder" badge={steps.length || undefined} />
            <RailBtn id="flows" icon={<Workflow size={20} />} tip="Saved flows" />
            <RailBtn id="accounts" icon={<UserRound size={20} />} tip="Accounts & logins" />
            <RailBtn id="data" icon={<FileSpreadsheet size={20} />} tip="Data (Excel, CSV, PDF)" />
          </div>
          <div className="railgroup glass dock">
            <RailBtn id="runs" icon={runningCount ? <Loader2 size={20} className="spin" /> : <History size={20} />} tip="Runs & results" badge={runningCount || undefined} />
            <RailBtn id="settings" icon={settings?.has_api_key ? <Bot size={20} /> : <Cog size={20} />} tip="Settings & AI" />
          </div>
        </nav>

        {/* ---------------------------------------------- page */}
        <main className="pagewrap" style={pauses.length ? { display: 'flex', flexDirection: 'column', gap: 8 } : undefined}>
          {pauses.map((p) => (
            <div key={p.runId} className="pausebar glass" role="alert">
              <Hand size={18} color="var(--warn)" style={{ flex: 'none' }} />
              <div className="grow">
                <b>Paused{p.row ? ` · row ${p.row}` : ''}</b> — {p.message}
                <div className="small muted">{flows.find((f) => f.id === p.flowId)?.name || 'Run'}{p.profileId ? ` · ${profileOf(p.profileId)?.name || ''}` : ''}</div>
              </div>
              <button className="btn primary sm" onClick={() => b.runner.resume(p.runId, 'continue')}>Continue</button>
              {p.row != null && <button className="btn sm" onClick={() => b.runner.resume(p.runId, 'skip')}>Skip this row</button>}
              <button className="btn sm danger" onClick={() => b.runner.resume(p.runId, 'stop')}>Stop</button>
            </div>
          ))}
          {inFirefox ? (
            <div className="start">
              <div className="card" style={{ maxWidth: 460, textAlign: 'center', alignItems: 'center' }}>
                <div className="title" style={{ fontSize: 16 }}>This tab is open in Firefox</div>
                <div className="small muted ellipsis" style={{ maxWidth: 400 }}>{activeTab!.title} · {activeTab!.url}</div>
                <div className="small muted">Use the Firefox window to browse. Recording, runs and data work from here as usual.</div>
                <button className="btn primary" onClick={() => b.tabs.showFirefox(activeTab!.id)}>Show Firefox window</button>
              </div>
            </div>
          ) : showStart ? (
            <StartPage onGo={navigate} flows={flows} onOpenFlows={() => setPanel('flows')} hasBackendError={backendError} />
          ) : (
            <div ref={frameRef} className={`pageframe ${rec.recording ? 'recording' : ''}`}>
              <div className="placeholder">Loading…</div>
            </div>
          )}
          {(showStart || inFirefox) && <div ref={frameRef} style={{ display: 'none' }} />}
        </main>

        {/* ---------------------------------------------- panel */}
        {panel && (
          <aside className="panel glass">
            {panel === 'recorder' && (
              <RecorderPanel ctx={ctx} rec={rec} steps={steps} setSteps={setSteps}
                editingFlow={editingFlow} setEditingFlow={setEditingFlow} onClose={() => setPanel(null)}
                recData={recData} setRecData={setRecData} />
            )}
            {panel === 'flows' && (
              <FlowsPanel key={focusFlowId || 'flows'} ctx={ctx} onClose={() => setPanel(null)}
                onEdit={(f) => { setEditingFlow(f); setSteps(f.steps); setPanel('recorder'); }} />
            )}
            {panel === 'accounts' && <AccountsPanel ctx={ctx} onClose={() => setPanel(null)} />}
            {panel === 'data' && <DataPanel ctx={ctx} onClose={() => setPanel(null)} />}
            {panel === 'runs' && <RunsPanel ctx={ctx} logs={logs} running={running} progress={progress} onClose={() => setPanel(null)} />}
            {panel === 'settings' && <SettingsPanel ctx={ctx} onClose={() => setPanel(null)} />}
          </aside>
        )}
      </div>
      {toastMsg && <div className={`toast glass ${toastMsg.error ? 'error' : ''}`} role="status">{toastMsg.msg}</div>}
    </>
  );
}
