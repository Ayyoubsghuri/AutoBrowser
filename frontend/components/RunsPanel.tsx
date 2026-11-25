'use client';
import { useEffect, useMemo, useState } from 'react';
import { Download, History, RefreshCw, Square, X } from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { api, get, getBase64 } from '@/lib/api';
import type { Run, RunLog, RunProgress } from '@/lib/types';
import type { AppCtx } from './Shell';

const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const STATUS_TAG: Record<string, string> = { success: 'ok', failed: 'err', stopped: 'warn', running: 'ai' };

export function RunsPanel({ ctx, logs, running, progress = {}, onClose }: { ctx: AppCtx; logs: RunLog[]; running: Record<string, string>; progress?: Record<string, RunProgress>; onClose: () => void }) {
  const b = bridge();
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => get<Run[]>('/runs?limit=40').then(setRuns).catch((e) => ctx.toast(e.message, true));
  useEffect(() => { load(); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveIds = Object.entries(running).filter(([, s]) => s === 'running').map(([id]) => id);
  const liveLogs = useMemo(() => logs.filter((l) => liveIds.includes(l.runId)).slice(-200), [logs, liveIds]);
  const flowName = (id: string | null) => ctx.flows.find((f) => f.id === id)?.name || 'Deleted flow';
  const profName = (id: string | null) => ctx.profiles.find((p) => p.id === id)?.name || 'Default';

  const downloadCsv = async (r: Run) => {
    try {
      const csv = await api<string>('GET', `/runs/${r.id}/output.csv`);
      await b.saveFile({ name: `${flowName(r.flow_id).replace(/[^\w-]+/g, '_')}-${r.id}.csv`, content: csv });
    } catch (e: any) { ctx.toast(e.message, true); }
  };
  const downloadXlsx = async (r: Run) => {
    try {
      const b64 = await getBase64(`/runs/${r.id}/results.xlsx`);
      await b.saveFile({ name: `${flowName(r.flow_id).replace(/[^\w-]+/g, '_')}-${r.id}.xlsx`, content: b64, base64: true });
    } catch (e: any) { ctx.toast(e.message, true); }
  };
  const downloadJson = async (r: Run) => {
    await b.saveFile({ name: `run-${r.id}.json`, content: JSON.stringify(r.output, null, 2) });
  };

  return (
    <>
      <header>
        <h2>Runs</h2>
        {liveIds.length > 0 && <button className="btn sm danger" onClick={() => b.runner.stop()}><Square size={12} /> Stop all</button>}
        <button className="iconbtn" onClick={load} aria-label="Refresh"><RefreshCw size={15} /></button>
        <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="body">
        {liveIds.length > 0 && (
          <div className="card">
            <div className="row"><span className="tag ai">live</span><span className="small muted">{liveIds.length} running</span></div>
            {liveIds.map((id) => progress[id]).filter(Boolean).map((p) => (
              <div key={p!.runId}>
                <div className="row small"><span className="grow">Rows {p!.done} / {p!.total}</span><span className="tag ok">{p!.ok} ok</span>{p!.failed > 0 && <span className="tag err">{p!.failed} failed</span>}</div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--hair)', overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ width: `${p!.total ? (100 * p!.done) / p!.total : 0}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s' }} />
                </div>
              </div>
            ))}
            <div>
              {liveLogs.map((l, i) => (
                <div key={i} className={`logline ${l.level}`}><span className="ts">{fmt(l.t)}</span><span>{l.msg}</span></div>
              ))}
            </div>
          </div>
        )}
        {runs.length === 0 && <div className="empty"><div className="big"><History size={26} /></div>No runs yet.</div>}
        {runs.map((r) => {
          const rowResults = r.output.filter((o) => o.name === '_rows').flatMap((o) => (Array.isArray(o.data) ? o.data : [])) as Record<string, unknown>[];
          const okRows = rowResults.filter((x) => x._status === 'success').length;
          const rows = r.output.reduce((n, o) => n + (Array.isArray(o.data) ? o.data.length : 1), 0);
          return (
            <div key={r.id} className="card compact">
              <button className="row" style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left' }} onClick={() => setOpen(open === r.id ? null : r.id)}>
                <div className="grow">
                  <div className="title ellipsis">{flowName(r.flow_id)}</div>
                  <div className="small muted">{new Date(r.started * 1000).toLocaleString()} · {profName(r.profile_id)} · {r.mode}</div>
                </div>
                <span className={`tag ${STATUS_TAG[r.status] || ''}`}>{r.status}</span>
              </button>
              {rows > 0 && (
                <div className="row">
                  <span className="small muted grow">
                    {rowResults.length ? <>{okRows}/{rowResults.length} data rows done{rowResults.length - okRows ? <b style={{ color: 'var(--rec)' }}> · {rowResults.length - okRows} failed</b> : ''}</> : <>{rows} result row{rows === 1 ? '' : 's'}</>}
                  </span>
                  <button className="btn sm" onClick={() => downloadXlsx(r)} title="Your rows + status / message / extracted values"><Download size={12} /> Excel</button>
                  <button className="btn sm" onClick={() => downloadCsv(r)}>CSV</button>
                  <button className="btn sm" onClick={() => downloadJson(r)}>JSON</button>
                </div>
              )}
              {open === r.id && (
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {r.log.map((l, i) => (
                    <div key={i} className={`logline ${l.level}`}><span className="ts">{fmt(l.t)}</span><span>{l.msg}</span></div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
