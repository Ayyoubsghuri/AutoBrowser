'use client';
import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Plus, ShieldCheck, Trash2, UserRound, X, Eraser } from 'lucide-react';
import { bridge } from '@/lib/bridge';
import { del, patch, post } from '@/lib/api';
import type { Engine, Profile } from '@/lib/types';
import type { AppCtx } from './Shell';

const COLORS = ['#6c5cff', '#1fa463', '#ef4b5b', '#f59e0b', '#0ea5e9', '#ec4899', '#14b8a6', '#64748b'];

function CredentialForm({ profile, onDone, ctx }: { profile: Profile; onDone: () => void; ctx: AppCtx }) {
  const [site, setSite] = useState(() => { try { return new URL(ctx.activeTab?.url || '').host; } catch { return ''; } });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const save = async () => {
    if (!site || !username) { ctx.toast('Site and username are required', true); return; }
    try {
      await post('/credentials', { profile_id: profile.id, site, username, password: password || null, totp_secret: totp || null });
      await ctx.reloadProfiles(); onDone();
    } catch (e: any) { ctx.toast(e.message, true); }
  };
  return (
    <div className="card" style={{ background: 'var(--input-bg)' }}>
      <label className="label">Website<input className="input" value={site} onChange={(e) => setSite(e.target.value)} placeholder="shop.example.com" /></label>
      <label className="label">Username / email<input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
      <label className="label">Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
      <label className="label">2FA secret (optional, base32 from the QR setup)<input className="input mono" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="JBSWY3DPEHPK3PXP" /></label>
      <div className="row"><button className="btn grow" onClick={onDone}>Cancel</button><button className="btn primary grow" onClick={save}>Save login</button></div>
      <div className="small muted row"><ShieldCheck size={12} /> Encrypted on this computer. Never sent to the AI.</div>
    </div>
  );
}

export function AccountsPanel({ ctx, onClose }: { ctx: AppCtx; onClose: () => void }) {
  const b = bridge();
  useEffect(() => { ctx.reloadProfiles(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [proxy, setProxy] = useState('');
  const [engine, setEngine] = useState<Engine>(ctx.settings?.default_engine || 'chromium');
  const [color, setColor] = useState(COLORS[ctx.profiles.length % COLORS.length]);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwVal, setPwVal] = useState('');

  const create = async () => {
    if (!name.trim()) return;
    try {
      const p = await post<Profile>('/profiles', { name: name.trim(), color, proxy: proxy.trim() || null, engine });
      await ctx.reloadProfiles();
      setCreating(false); setName(''); setProxy('');
      setAddingFor(p.id);
    } catch (e: any) { ctx.toast(e.message, true); }
  };

  return (
    <>
      <header>
        <h2>Accounts</h2>
        <button className="btn sm" onClick={() => setCreating((v) => !v)}><Plus size={14} /> New</button>
        <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="body">
        <div className="small muted">
          Each account is a separate browser profile with its own cookies, storage and saved logins — so you can stay logged in to many
          accounts of the same site and run a flow for each one.
        </div>
        {creating && (
          <div className="card">
            <label className="label">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Store account #1" /></label>
            <label className="label">Proxy (optional)<input className="input mono" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://user:pass@host:port or socks5://host:port" /></label>
            <div className="row">{COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} aria-label={c} style={{ width: 22, height: 22, borderRadius: 11, border: color === c ? '2px solid var(--ink)' : '2px solid transparent', background: c }} />
            ))}</div>
            <div className="label">Browser
              <div className="segmented">
                <button className={engine === 'chromium' ? 'on' : ''} onClick={() => setEngine('chromium')}>Built-in (Chromium)</button>
                <button className={engine === 'firefox' ? 'on' : ''} onClick={() => setEngine('firefox')}>Firefox</button>
              </div>
              {engine === 'firefox' && <span className="small muted">Opens in its own Firefox window. Install it once in Settings → Browser engine.</span>}
            </div>
            <button className="btn primary" onClick={create}>Create account profile</button>
          </div>
        )}
        {ctx.profiles.length === 0 && !creating && (
          <div className="empty"><div className="big"><UserRound size={26} /></div>No accounts yet. Create one per login you want to automate.</div>
        )}
        {ctx.profiles.map((p) => (
          <div key={p.id} className="card">
            <div className="row">
              <span className="dot" style={{ background: p.color, width: 12, height: 12 }} />
              <div className="grow">
                <div className="title">{p.name}</div>
                {p.proxy && <div className="small muted mono ellipsis">via {p.proxy.replace(/\/\/.*@/, '//•••@')}</div>}
                <select className="small" style={{ border: 0, background: 'transparent', color: 'var(--muted)', padding: 0 }} value={p.engine || 'chromium'}
                  title="Browser used for this account" aria-label="Browser"
                  onChange={async (e) => { await patch(`/profiles/${p.id}`, { engine: e.target.value }); await ctx.reloadProfiles(); ctx.toast('Applies to tabs opened from now on'); }}>
                  <option value="chromium">Built-in (Chromium)</option>
                  <option value="firefox">Firefox window</option>
                </select>
              </div>
              <button className="iconbtn" title="Open a tab as this account (log in manually once — the session is kept)" aria-label="Open tab"
                onClick={() => b.tabs.create({ url: ctx.activeTab?.url || '', profileId: p.id })}><ExternalLink size={15} /></button>
              <button className="iconbtn" title="Clear cookies & site data" aria-label="Clear data"
                onClick={async () => { if (confirm(`Log out of everything in "${p.name}"?`)) { await b.profiles.clearData(p.id); ctx.toast('Cleared'); } }}><Eraser size={15} /></button>
              <button className="iconbtn" title="Delete" aria-label="Delete"
                onClick={async () => { if (confirm(`Delete account "${p.name}" and its saved logins?`)) { await del(`/profiles/${p.id}`); ctx.reloadProfiles(); } }}><Trash2 size={15} /></button>
            </div>
            {p.credentials.map((c) => (
              <div key={c.id} className="row small" style={{ padding: '4px 0', borderTop: '1px solid var(--hair)' }}>
                <KeyRound size={13} className="muted" />
                <span className="grow ellipsis"><b>{c.site}</b> · {c.username}</span>
                {c.has_totp && <span className="tag ok">2FA</span>}
                <button className="iconbtn" style={{ width: 26, height: 26 }} title="Change password" aria-label="Change password"
                  onClick={() => { setPwFor(pwFor === c.id ? null : c.id); setPwVal(''); }}>
                  <KeyRound size={12} />
                </button>
                <button className="iconbtn" style={{ width: 26, height: 26 }} aria-label="Delete login"
                  onClick={async () => { await del(`/credentials/${c.id}`); ctx.reloadProfiles(); }}><Trash2 size={12} /></button>
              </div>
            ))}
            {p.credentials.some((c) => c.id === pwFor) && (
              <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!pwVal) return; await patch(`/credentials/${pwFor}`, { password: pwVal }); setPwFor(null); ctx.toast('Password updated'); }}>
                <input className="input grow" type="password" autoFocus placeholder="New password" value={pwVal} onChange={(e) => setPwVal(e.target.value)} />
                <button className="btn sm primary" type="submit">Save</button>
              </form>
            )}
            {addingFor === p.id ? (
              <CredentialForm profile={p} ctx={ctx} onDone={() => setAddingFor(null)} />
            ) : (
              <button className="btn sm" onClick={() => setAddingFor(p.id)}><Plus size={13} /> Add saved login</button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
