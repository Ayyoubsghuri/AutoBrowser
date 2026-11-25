'use client';
import { useEffect, useState } from 'react';
import { Bot, Check, Gauge, ShieldCheck, X } from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { put } from '@/lib/api';
import type { AppCtx } from './Shell';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
];

export function SettingsPanel({ ctx, onClose }: { ctx: AppCtx; onClose: () => void }) {
  const s = ctx.settings;
  const [key, setKey] = useState('');
  const [info, setInfo] = useState<{ chrome: string; version: string } | null>(null);
  useEffect(() => { bridge().backend().then(setInfo).catch(() => {}); }, []);

  const save = async (body: Record<string, unknown>, msg = 'Saved') => {
    try { await put('/settings', body); await ctx.reloadSettings(); ctx.toast(msg); } catch (e: any) { ctx.toast(e.message, true); }
  };

  return (
    <>
      <header>
        <h2>Settings</h2>
        <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="body">
        <div className="card">
          <div className="row"><Bot size={16} color="var(--accent)" /><div className="title grow">AI (optional)</div>
            {s?.has_api_key ? <span className="tag ok"><Check size={11} /> key saved</span> : <span className="tag">not set</span>}</div>
          <div className="small muted">
            Needed only for “Build with AI”, AI steps and AI assist. Exact replays never call the AI.
            Get a key at console.anthropic.com. Passwords and 2FA codes are never sent to the AI.
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); save({ anthropic_api_key: key }, key ? 'API key saved (encrypted)' : 'API key removed'); setKey(''); }}>
            <input className="input grow mono" type="password" placeholder={s?.has_api_key ? '•••••••• (enter to replace)' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" type="submit">{key ? 'Save' : s?.has_api_key ? 'Remove' : 'Save'}</button>
          </form>
          <label className="label">Model
            <select className="select" value={s?.model || MODELS[0].id} onChange={(e) => save({ model: e.target.value })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>

        <div className="card">
          <div className="row"><Gauge size={16} color="var(--accent)" /><div className="title grow">Human-like speed</div><span className="small muted">{(s?.human_speed ?? 1).toFixed(1)}×</span></div>
          <input type="range" min={0.3} max={3} step={0.1} value={s?.human_speed ?? 1} onChange={(e) => save({ human_speed: Number(e.target.value) }, 'Speed updated')} />
          <div className="small muted">Delay multiplier for mouse movement, clicks and typing. Higher = slower and more natural.</div>
        </div>

        <div className="card">
          <div className="row"><ShieldCheck size={16} color="var(--accent)" /><div className="title grow">Look like regular Chrome</div>
            <input type="checkbox" checked={s?.stealth ?? true} onChange={(e) => save({ stealth: e.target.checked }, 'Applies to newly loaded pages')} /></div>
          <div className="small muted">
            Consistent Chrome user-agent and client hints, no webdriver flag, no DevTools protocol, real (trusted) mouse & keyboard
            input with natural timing, and one isolated profile per account. No tool is undetectable — respect each site&apos;s terms.
          </div>
        </div>

        {info && <div className="small muted" style={{ textAlign: 'center' }}>AutoBrowser {info.version} · Chromium {info.chrome}</div>}
      </div>
    </>
  );
}
