'use client';
import { useEffect, useState } from 'react';
import { Database, Link2, Plus, Upload, X } from 'lucide-react';
import { get, patch } from '@/lib/api';
import type { Dataset, FilterOp, Flow, FlowData } from '@/lib/types';
import { defaultRowStart, stepTitle } from '@/lib/steps';
import { DataTable, uploadFiles, useDatasets } from './DataPanel';
import type { AppCtx } from './Shell';

const OPS: { id: FilterOp; label: string; needsValue?: boolean }[] = [
  { id: 'not_empty', label: 'is not empty' },
  { id: 'empty', label: 'is empty' },
  { id: 'truthy', label: 'is yes / x / 1' },
  { id: 'falsy', label: 'is not yes' },
  { id: 'equals', label: 'equals', needsValue: true },
  { id: 'not_equals', label: 'is not', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
];

/** Per-flow data settings: which rows to loop over and where the per-row part starts. */
export function FlowDataCard({ ctx, flow, onSaved }: { ctx: AppCtx; flow: Flow; onSaved: () => void }) {
  const { list, reload } = useDatasets(ctx);
  const [cfg, setCfg] = useState<FlowData | null>(flow.data || null);
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[]; total: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setCfg(flow.data || null); setDirty(false); }, [flow.id, flow.data]);

  const loadPreview = () => get(`/flows/${flow.id}/data-rows?limit=5`).then(setPreview).catch(() => setPreview(null));
  useEffect(() => { if (flow.data) loadPreview(); else setPreview(null); }, [flow.id, flow.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const ds = (id?: string) => list.find((d) => d.id === id);
  const main = ds(cfg?.dataset_id);
  const update = (p: Partial<FlowData>) => { setCfg((c) => (c ? { ...c, ...p } : c)); setDirty(true); };
  const allColumns = [
    ...(main?.columns || []),
    ...(cfg?.joins || []).flatMap((j) => (ds(j.dataset_id)?.columns || []).map((c) => (j.prefix ? `${j.prefix}.${c}` : c))),
  ];

  const save = async (next: FlowData | null) => {
    try {
      await patch(`/flows/${flow.id}`, { data: next });
      setDirty(false);
      await ctx.reloadFlows();
      onSaved();
      ctx.toast(next ? 'Data settings saved' : 'Data removed from this flow');
    } catch (e: any) { ctx.toast(e.message, true); }
  };

  const pickMain = (id: string) => {
    if (!id) { setCfg(null); setDirty(true); return; }
    setCfg({ dataset_id: id, joins: cfg?.joins || [], filter: null, start_step_id: cfg?.start_step_id || defaultRowStart(flow.steps), stop_on_error: false, first_row: 1, max_rows: null });
    setDirty(true);
  };

  const importInto = (cb: (d: Dataset) => void) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.xlsx,.xlsm,.xls,.csv,.tsv,.pdf';
    inp.onchange = async () => {
      if (!inp.files?.length) return;
      try { const d = await uploadFiles(Array.from(inp.files)); await reload(); cb(d); } catch (e: any) { ctx.toast(e.message, true); }
    };
    inp.click();
  };

  return (
    <div className="card">
      <div className="row">
        <Database size={16} color="var(--ok)" />
        <div className="title grow">Data: run once per row</div>
        {flow.data && preview && <span className="tag ok">{preview.total} rows</span>}
      </div>
      <div className="row">
        <select className="select grow" value={cfg?.dataset_id || ''} onChange={(e) => pickMain(e.target.value)}>
          <option value="">No data: run once</option>
          {list.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.row_count} rows)</option>)}
        </select>
        <button className="btn sm" title="Import a file" onClick={() => importInto((d) => pickMain(d.id))}><Upload size={13} /></button>
      </div>

      {cfg && (
        <>
          {/* joins (VLOOKUP) */}
          {cfg.joins.map((j, i) => {
            const other = ds(j.dataset_id);
            const setJ = (p: Partial<FlowData['joins'][number]>) => update({ joins: cfg.joins.map((x, k) => (k === i ? { ...x, ...p } : x)) });
            return (
              <div key={i} className="card compact" style={{ background: 'var(--input-bg)' }}>
                <div className="row small"><Link2 size={13} /><b className="grow">Add columns from</b>
                  <button className="iconbtn" style={{ width: 24, height: 24 }} aria-label="Remove link" onClick={() => update({ joins: cfg.joins.filter((_, k) => k !== i) })}><X size={12} /></button></div>
                <select className="select small" value={j.dataset_id} onChange={(e) => setJ({ dataset_id: e.target.value, right: '' })}>
                  {list.filter((d) => d.id !== cfg.dataset_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <div className="row small" style={{ gap: 6 }}>
                  <span className="muted">where</span>
                  <select className="select small grow" value={j.left} onChange={(e) => setJ({ left: e.target.value })}>
                    <option value="">column in {main?.name || 'main'}…</option>
                    {(main?.columns || []).map((c) => <option key={c}>{c}</option>)}
                  </select>
                  <span className="muted">=</span>
                  <select className="select small grow" value={j.right} onChange={(e) => setJ({ right: e.target.value })}>
                    <option value="">column in {other?.name || 'other'}…</option>
                    {(other?.columns || []).map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
          {list.filter((d) => d.id !== cfg.dataset_id).length > 0 ? (
            <button className="btn sm" onClick={() => {
              const other = list.find((d) => d.id !== cfg.dataset_id)!;
              const common = (main?.columns || []).find((c) => other.columns.some((o) => o.toLowerCase() === c.toLowerCase()));
              update({ joins: [...cfg.joins, { dataset_id: other.id, left: common || '', right: other.columns.find((o) => o.toLowerCase() === (common || '').toLowerCase()) || '' }] });
            }}><Plus size={13} /> Link another file (match by a column)</button>
          ) : (
            <button className="btn sm" onClick={() => importInto(() => {})}><Plus size={13} /> Import a second file to link</button>
          )}

          {/* filter */}
          <div className="row small" style={{ gap: 6 }}>
            <span className="muted" style={{ flex: 'none' }}>Only rows where</span>
            <select className="select small grow" value={cfg.filter?.column || ''} onChange={(e) => update({ filter: e.target.value ? { column: e.target.value, op: cfg.filter?.op || 'not_empty', value: cfg.filter?.value } : null })}>
              <option value="">(all rows)</option>
              {allColumns.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          {cfg.filter && (
            <div className="row small" style={{ gap: 6 }}>
              <select className="select small grow" value={cfg.filter.op} onChange={(e) => update({ filter: { ...cfg.filter!, op: e.target.value as FilterOp } })}>
                {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {OPS.find((o) => o.id === cfg.filter!.op)?.needsValue && (
                <input className="input small grow" value={cfg.filter.value || ''} onChange={(e) => update({ filter: { ...cfg.filter!, value: e.target.value } })} />
              )}
            </div>
          )}

          {/* where the per-row part starts */}
          <label className="label">Repeat for each row starting at step
            <select className="select small" value={cfg.start_step_id || ''} onChange={(e) => update({ start_step_id: e.target.value || null })}>
              {flow.steps.map((s, i) => <option key={s.id} value={s.id}>{i + 1}. {stepTitle(s)}</option>)}
            </select>
            <span className="small muted">Steps before it (e.g. logging in) run once.</span>
          </label>
          <div className="row small wrap" style={{ gap: 10 }}>
            <label className="row" style={{ gap: 4 }}>From row <input className="input small" style={{ width: 64 }} type="number" min={1} value={cfg.first_row || 1} onChange={(e) => update({ first_row: Math.max(1, Number(e.target.value)) })} /></label>
            <label className="row" style={{ gap: 4 }}>Max <input className="input small" style={{ width: 64 }} type="number" min={1} placeholder="all" value={cfg.max_rows || ''} onChange={(e) => update({ max_rows: e.target.value ? Number(e.target.value) : null })} /></label>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={!!cfg.stop_on_error} onChange={(e) => update({ stop_on_error: e.target.checked })} /> stop at first error</label>
          </div>
        </>
      )}

      {dirty && (
        <button className="btn primary sm" disabled={!!cfg && (!cfg.dataset_id || cfg.joins.some((j) => !j.left || !j.right))} onClick={() => save(cfg)}>Save data settings</button>
      )}
      {!dirty && flow.data && preview && (
        <>
          <div className="small muted">Rows this flow will process (first 5 of {preview.total}). Use them in steps as <span className="mono">{'{{row.Column}}'}</span>.</div>
          <DataTable columns={preview.columns} rows={preview.rows} max={5} />
        </>
      )}
    </div>
  );
}
