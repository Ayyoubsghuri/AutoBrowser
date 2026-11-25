'use client';
import { useEffect, useState } from 'react';
import { Bot, Check, Gauge, ShieldCheck, X } from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { put } from '@/lib/api';
import type { AppCtx } from './Shell';

type ProviderId = 'anthropic' | 'openai' | 'nvidia';

const PROVIDERS: { id: ProviderId; label: string; keyHint: string; keyUrl: string; models: { id: string; label: string }[] }[] = [
  {
    id: 'anthropic', label: 'Claude', keyHint: 'sk-ant-…', keyUrl: 'console.anthropic.com',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', keyHint: 'sk-…', keyUrl: 'platform.openai.com',
    models: [
      { id: 'gpt-5', label: 'gpt-5' },
      { id: 'gpt-5-mini', label: 'gpt-5-mini' },
      { id: 'gpt-4.1', label: 'gpt-4.1' },
      { id: 'gpt-4o', label: 'gpt-4o' },
    ],
  },
  {
    id: 'nvidia', label: 'NVIDIA', keyHint: 'nvapi-…', keyUrl: 'build.nvidia.com',
    models: [
      { id: 'meta/llama-3.3-70b-instruct', label: 'meta/llama-3.3-70b-instruct' },
      { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', label: 'nvidia/llama-3.3-nemotron-super-49b-v1' },
      { id: 'deepseek-ai/deepseek-r1', label: 'deepseek-ai/deepseek-r1' },
      { id: 'qwen/qwen2.5-coder-32b-instruct', label: 'qwen/qwen2.5-coder-32b-instruct' },
    ],
  },
];

export function SettingsPanel({ ctx, onClose }: { ctx: AppCtx; onClose: () => void }) {
  const s = ctx.settings;
  const [key, setKey] = useState('');
  const provider: ProviderId = (s?.provider as ProviderId) || 'anthropic';
  const meta = PROVIDERS.find((p) => p.id === provider)!;
  const currentModel = s?.providers?.[provider]?.model || s?.model || meta.models[0].id;
  const [model, setModel] = useState(currentModel);
  const [baseUrl, setBaseUrl] = useState(s?.providers?.openai?.base_url || '');
  useEffect(() => { setModel(currentModel); setKey(''); }, [provider, currentModel]);
  useEffect(() => { setBaseUrl(s?.providers?.openai?.base_url || ''); }, [s?.providers?.openai?.base_url]);
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
            Passwords and 2FA codes are never sent to the AI.
          </div>
          <div className="segmented">
            {PROVIDERS.map((p) => (
              <button key={p.id} className={provider === p.id ? 'on' : ''} onClick={() => save({ provider: p.id }, `Using ${p.label}`)}>
                {p.label}{s?.providers?.[p.id]?.has_key ? ' ✓' : ''}
              </button>
            ))}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); save({ [`${provider}_api_key`]: key }, key ? 'API key saved (encrypted)' : 'API key removed'); setKey(''); }}>
            <input className="input grow mono" type="password" placeholder={s?.has_api_key ? '•••••••• (enter to replace)' : meta.keyHint} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" type="submit">{key ? 'Save' : s?.has_api_key ? 'Remove' : 'Save'}</button>
          </form>
          <div className="small muted">Get a {meta.label} key at {meta.keyUrl}</div>
          <form className="label" onSubmit={(e) => { e.preventDefault(); if (model.trim()) save({ [`${provider}_model`]: model.trim() }, 'Model saved'); }}>
            Model
            <div className="row">
              <input className="input grow mono" list={`models-${provider}`} value={model} onChange={(e) => setModel(e.target.value)}
                onBlur={() => { if (model.trim() && model.trim() !== currentModel) save({ [`${provider}_model`]: model.trim() }, 'Model saved'); }} />
              <datalist id={`models-${provider}`}>{meta.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
            </div>
            <span className="small muted">Pick a suggestion or type any model id your account can use.</span>
          </form>
          {provider === 'openai' && (
            <form className="label" onSubmit={(e) => { e.preventDefault(); save({ openai_base_url: baseUrl }, 'Server saved'); }}>
              Server URL (optional)
              <input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1"
                onBlur={() => { if (baseUrl !== (s?.providers?.openai?.base_url || '')) save({ openai_base_url: baseUrl }, 'Server saved'); }} />
              <span className="small muted">Leave empty for OpenAI. Set it to use any OpenAI-compatible server (OpenRouter, Ollama, LM Studio…).</span>
            </form>
          )}
          {provider === 'nvidia' && (
            <div className="small muted">Uses NVIDIA&apos;s hosted API (integrate.api.nvidia.com). Screenshots are only sent to vision models.</div>
          )}
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
