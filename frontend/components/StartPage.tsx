'use client';
import { useState } from 'react';
import { Workflow, AlertTriangle } from 'lucide-react';
import type { Flow } from '@/lib/types';
import { hostPath } from '@/lib/steps';

export function GMark() {
  return (
    <svg className="gmark" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z" />
    </svg>
  );
}

export function StartPage({ onGo, flows, onOpenFlows, hasBackendError }: {
  onGo: (q: string) => void; flows: Flow[]; onOpenFlows: () => void; hasBackendError: string | null;
}) {
  const [q, setQ] = useState('');
  return (
    <div className="start">
      <h1>Where do we automate today?</h1>
      <form className="search glass pill" onSubmit={(e) => { e.preventDefault(); onGo(q); }}>
        <GMark />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the web" spellCheck={false} />
      </form>
      {hasBackendError && (
        <div className="card compact row" style={{ width: 'min(640px,100%)' }}>
          <AlertTriangle size={16} color="var(--warn)" />
          <span className="small">Backend not reachable: {hasBackendError}</span>
        </div>
      )}
      <div className="tiles">
        {flows.slice(0, 5).map((f) => (
          <button key={f.id} className="tile glass" onClick={onOpenFlows}>
            <Workflow size={16} color="var(--accent)" />
            <b className="ellipsis">{f.name}</b>
            <span className="ellipsis">{f.steps.length} steps · {hostPath(f.start_url || '') || 'any site'}</span>
          </button>
        ))}
        <button className="tile glass" onClick={() => onGo('https://example.com')}>
          <b>How it works</b>
          <span>Open a site → press <b>Record</b> → click around → add tips → save.</span>
        </button>
      </div>
    </div>
  );
}
