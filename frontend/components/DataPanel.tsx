'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, FileSpreadsheet, FileText, Lock, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { del, fileToBase64, get, patch, post } from '@/lib/api';
import { bridge } from '@/lib/bridge';
import type { Dataset, PdfRule } from '@/lib/types';
import type { AppCtx } from './Shell';

const ACCEPT = '.xlsx,.xlsm,.xls,.csv,.tsv,.pdf';

export function DataTable({ columns, rows, max = 8 }: { columns: string[]; rows: Record<string, unknown>[]; max?: number }) {
  const cols = columns.filter((c) => !c.startsWith('_matched_'));
  if (!rows.length) return <div className="small muted">No rows.</div>;
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table className="minitable">
        <thead><tr>{cols.map((c) => <th key={c} title={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>{cols.map((c) => {
              const v = c.includes('.') && !(c in r) ? (r as any)[c.split('.')[0]]?.[c.split('.').slice(1).join('.')] : r[c];
              return <td key={c} title={String(v ?? '')}>{String(v ?? '')}</td>;
            })}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function useDatasets(ctx: AppCtx) {
  const [list, setList] = useState<Dataset[]>([]);
  const reload = () => get<Dataset[]>('/datasets').then(setList).catch((e) => ctx.toast(e.message, true));
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, reload };
}

export async function uploadFiles(files: File[], extra: Record<string, unknown> = {}): Promise<Dataset> {
  const payload = await Promise.all(files.map(async (f) => ({ filename: f.name, content_b64: await fileToBase64(f) })));
  const b = bridge();
  const source = files.length === 1 && b.pathForFile ? b.pathForFile(files[0]) : null;
  return post<Dataset>('/datasets', { files: payload, ...(source ? { source_path: source } : {}), ...extra });
}

function PdfRules({ ds, onChange, ctx }: { ds: Dataset; onChange: (d: Dataset) => void; ctx: AppCtx }) {
  const [rules, setRules] = useState<PdfRule[]>(ds.rules);
  const [want, setWant] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const privateMode = ctx.settings?.privacy_mode !== false;
  useEffect(() => setRules(ds.rules), [ds.rules]);

  const save = async (r: PdfRule[]) => {
    try { onChange(await patch<Dataset>(`/datasets/${ds.id}`, { rules: r })); ctx.toast('Fields updated'); } catch (e: any) { ctx.toast(e.message, true); }
  };
  const fields = () => want.split(',').map((s) => s.trim()).filter(Boolean);
  const suggest = async () => {
    setBusy('suggest');
    try {
      const res = await post<{ rules: PdfRule[]; notes: string }>(`/datasets/${ds.id}/suggest-rules`, { fields: fields() });
      const merged = [...rules.filter((r) => !res.rules.some((x) => x.name === r.name)), ...res.rules];
      setRules(merged); await save(merged);
      if (res.notes) ctx.toast(res.notes);
    } catch (e: any) { ctx.toast(e.message, true); } finally { setBusy(null); }
  };
  const aiExtract = async () => {
    setBusy('extract');
    try { onChange(await post<Dataset>(`/datasets/${ds.id}/ai-extract`, { fields: fields() })); ctx.toast('Extracted'); }
    catch (e: any) { ctx.toast(e.message, true); } finally { setBusy(null); }
  };
  const set = (i: number, p: Partial<PdfRule>) => setRules((cur) => cur.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="card">
      <div className="title">Fields to read from each PDF</div>
      <div className="small muted">
        <b>Form field</b> reads a fillable PDF field. <b>After label</b> takes the text printed after a label (e.g. “File number”).
        <b> Regex</b> for anything else. All of this runs on your computer.
      </div>
      {rules.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input className="input small" style={{ width: 110 }} value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="column" />
          <select className="select small" style={{ width: 110 }} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as PdfRule['kind'] })}>
            <option value="form_field">Form field</option><option value="after_label">After label</option><option value="regex">Regex</option>
            {r.kind === 'value' && <option value="value">AI values</option>}
          </select>
          {r.kind === 'form_field' ? (
            <select className="select small grow" value={r.pattern || ''} onChange={(e) => set(i, { pattern: e.target.value })}>
              <option value="">choose…</option>
              {[...new Set(ds.files.flatMap((f) => f.form_fields))].map((f) => <option key={f}>{f}</option>)}
            </select>
          ) : r.kind === 'value' ? <span className="small muted grow">filled by AI</span> : (
            <input className="input small grow mono" value={r.pattern || ''} onChange={(e) => set(i, { pattern: e.target.value })} placeholder={r.kind === 'regex' ? 'No\\.?\\s*(\\d+)' : 'File number'} />
          )}
          <button className="iconbtn" style={{ width: 26, height: 26 }} aria-label="Remove field" onClick={() => setRules((cur) => cur.filter((_, j) => j !== i))}><X size={13} /></button>
        </div>
      ))}
      <div className="row">
        <button className="btn sm" onClick={() => setRules((cur) => [...cur, { name: `field_${cur.length + 1}`, kind: 'after_label', pattern: '' }])}><Plus size={13} /> Field</button>
        <button className="btn sm primary" onClick={() => save(rules)}>Apply</button>
      </div>
      <div className="section" style={{ margin: '4px 0 0' }}>Let the AI help</div>
      <input className="input small" value={want} onChange={(e) => setWant(e.target.value)} placeholder="Fields you need, e.g. applicant, file number, date" />
      <div className="row wrap">
        <button className="btn sm" disabled={!!busy} onClick={suggest}><Sparkles size={13} />{busy === 'suggest' ? 'Thinking…' : 'Suggest rules'}</button>
        <button className="btn sm" disabled={!!busy || privateMode} onClick={aiExtract} title={privateMode ? 'Needs private mode off or a local model' : ''}>
          {busy === 'extract' ? 'Reading…' : 'AI reads each PDF'}
        </button>
      </div>
      <div className="small muted row" style={{ alignItems: 'flex-start' }}>
        <Lock size={12} style={{ flex: 'none', marginTop: 2 }} />
        {privateMode
          ? 'Private mode: “Suggest rules” only shows the AI the labels shared by all your PDFs (values are masked). “AI reads each PDF” needs a local model or private mode off.'
          : 'Private mode is off: “AI reads each PDF” sends the full text of every PDF to the AI.'}
      </div>
    </div>
  );
}

export function DataPanel({ ctx, onClose }: { ctx: AppCtx; onClose: () => void }) {
  const { list, reload } = useDatasets(ctx);
  const [sel, setSel] = useState<Dataset | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addPdfRef = useRef<HTMLInputElement>(null);

  const open = async (id: string) => { try { setSel(await get<Dataset>(`/datasets/${id}`)); } catch (e: any) { ctx.toast(e.message, true); } };

  const onFiles = async (files: FileList | null, toDataset?: string) => {
    if (!files || !files.length) return;
    const arr = Array.from(files);
    const pdfs = arr.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    setBusy(true);
    try {
      if (pdfs.length) {
        const d = await uploadFiles(pdfs, toDataset ? { dataset_id: toDataset } : {});
        setSel(d);
      }
      for (const f of arr.filter((x) => !x.name.toLowerCase().endsWith('.pdf'))) setSel(await uploadFiles([f]));
      reload();
    } catch (e: any) { ctx.toast(e.message, true); } finally { setBusy(false); }
  };

  const hidden = (
    <>
      <input ref={fileRef} type="file" multiple accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      <input ref={addPdfRef} type="file" multiple accept=".pdf" style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files, sel?.id); e.target.value = ''; }} />
    </>
  );

  if (sel) {
    return (
      <>
        {hidden}
        <header>
          <button className="iconbtn" onClick={() => { setSel(null); reload(); }} aria-label="Back"><ChevronLeft size={18} /></button>
          <h2 className="ellipsis">{sel.name}</h2>
          <button className="iconbtn" aria-label="Delete" onClick={async () => { if (confirm(`Delete "${sel.name}"?`)) { await del(`/datasets/${sel.id}`); setSel(null); reload(); } }}><Trash2 size={15} /></button>
        </header>
        <div className="body">
          <div className="card compact">
            <div className="row">
              {sel.kind === 'pdf' ? <FileText size={16} color="var(--accent)" /> : <FileSpreadsheet size={16} color="var(--ok)" />}
              <div className="grow small"><b>{sel.row_count}</b> rows · {sel.columns.filter((c) => c !== '_file').length} columns</div>
            </div>
            {sel.kind !== 'pdf' && sel.sheets.length > 1 && (
              <label className="label">Sheet
                <select className="select" value={sel.sheet || ''} onChange={async (e) => setSel(await patch<Dataset>(`/datasets/${sel.id}`, { sheet: e.target.value }))}>
                  {sel.sheets.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
            )}
            {sel.kind !== 'pdf' && (
              <label className="label">Header row (the row with the column names)
                <input className="input" type="number" min={1} value={sel.header_row}
                  onChange={async (e) => { const n = Number(e.target.value); if (n >= 1) setSel(await patch<Dataset>(`/datasets/${sel.id}`, { header_row: n })); }} />
              </label>
            )}
            {sel.kind === 'pdf' && (
              <div className="row wrap" style={{ gap: 4 }}>
                {sel.files.slice(0, 12).map((f) => <span key={f.name} className="tag" title={`${f.pages} page(s)`}>{f.name}</span>)}
                {sel.files.length > 12 && <span className="tag">+{sel.files.length - 12}</span>}
                <button className="btn sm" onClick={() => addPdfRef.current?.click()}><Plus size={12} /> PDFs</button>
              </div>
            )}
          </div>
          {sel.kind === 'pdf' && <PdfRules ds={sel} ctx={ctx} onChange={setSel} />}
          <div className="section">Preview</div>
          <DataTable columns={sel.columns} rows={sel.rows} max={20} />
          <div className="small muted">Use it in a flow: Flows → your flow → Data, or pick it in the Recorder before recording.</div>
        </div>
      </>
    );
  }

  return (
    <>
      {hidden}
      <header>
        <h2>Data</h2>
        <button className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={14} />{busy ? 'Reading…' : 'Import'}</button>
        <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="body">
        <div className="small muted">
          Excel, CSV or PDFs to fill into websites, one row at a time. Several PDFs become one table (one row per PDF).
          Link a second file to the first by a shared column (like VLOOKUP) in the flow&apos;s Data settings.
          Files stay on this computer.
        </div>
        {list.length === 0 && (
          <div className="empty"><div className="big"><FileSpreadsheet size={26} /></div>No data yet.
            <button className="btn primary" onClick={() => fileRef.current?.click()}><Upload size={14} /> Import Excel, CSV or PDFs</button></div>
        )}
        {list.map((d) => (
          <button key={d.id} className="card compact" style={{ textAlign: 'left' }} onClick={() => open(d.id)}>
            <div className="row">
              {d.kind === 'pdf' ? <FileText size={16} color="var(--accent)" /> : <FileSpreadsheet size={16} color="var(--ok)" />}
              <div className="grow">
                <div className="title ellipsis">{d.name}</div>
                <div className="small muted ellipsis">{d.row_count} rows · {d.columns.filter((c) => c !== '_file').slice(0, 5).join(', ')}{d.columns.length > 5 ? '…' : ''}</div>
              </div>
              <span className="tag">{d.kind}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
