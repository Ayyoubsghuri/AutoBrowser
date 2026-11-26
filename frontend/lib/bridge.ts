'use client';
import type { RunMode, TabInfo } from './types';

type Unsub = () => void;

export interface Bridge {
  isDesktop: boolean;
  backend(): Promise<{ port: number; token: string; platform: string; chrome: string; version: string }>;
  tabs: {
    list(): Promise<{ tabs: TabInfo[]; activeTabId: number | null }>;
    create(o?: { url?: string; profileId?: string | null }): Promise<TabInfo>;
    close(id: number): Promise<void>;
    activate(id: number): Promise<void>;
    navigate(id: number | null, input: string): Promise<void>;
    back(id?: number): Promise<void>;
    forward(id?: number): Promise<void>;
    reload(id?: number): Promise<void>;
    setProfile(id: number | null, profileId: string | null): Promise<TabInfo>;
    showFirefox(id?: number | null): Promise<void>;
  };
  engine: { status(): Promise<{ firefoxInstalled: boolean; defaultEngine: string }>; installFirefox(): Promise<boolean> };
  setPageBounds(rect: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  previewTemplate(str: string, vars: Record<string, unknown>): Promise<{ text?: string; error?: string }>;
  profiles: { refresh(): Promise<void>; clearData(profileId: string | null): Promise<boolean> };
  settings: { refresh(): Promise<void> };
  recorder: { start(tabId?: number | null): Promise<void>; stop(): Promise<void>; setMode(mode: string): Promise<void> };
  runner: {
    run(o: { flow: unknown; profileIds: (string | null)[]; mode: RunMode; parallel?: boolean; rows?: number[] }): Promise<{ runId: string; status: string }[]>;
    stop(runId?: string): Promise<void>;
    resume(runId: string, action: 'continue' | 'skip' | 'stop'): Promise<boolean>;
  };
  openExternal(url: string): Promise<void>;
  saveFile(o: { name: string; content: string; base64?: boolean; defaultPath?: string | null }): Promise<string | null>;
  pathForFile?(file: File): string | null;
  on(channel: string, cb: (payload: any) => void): Unsub;
}

// Browser-only fallback so the UI can be developed/previewed with `next dev`
// outside Electron (against a backend started with a fixed token).
function mockBridge(): Bridge {
  const listeners = new Map<string, Set<(p: any) => void>>();
  let tabs: TabInfo[] = [{ id: 1, profileId: null, title: 'New tab', url: '', favicon: null, loading: false, canGoBack: false, canGoForward: false }];
  let active = 1;
  const fire = (ch: string, p: any) => listeners.get(ch)?.forEach((f) => f(p));
  const push = () => fire('tabs:update', { tabs, activeTabId: active });
  const noop = async () => {};
  return {
    isDesktop: false,
    backend: async () => ({
      port: Number(process.env.NEXT_PUBLIC_AB_PORT || 8765),
      token: process.env.NEXT_PUBLIC_AB_TOKEN || 'dev-token',
      platform: 'web', chrome: '-', version: 'dev',
    }),
    tabs: {
      list: async () => ({ tabs, activeTabId: active }),
      create: async (o) => {
        const t = { id: Date.now(), profileId: o?.profileId ?? null, title: o?.url || 'New tab', url: o?.url || '', favicon: null, loading: false, canGoBack: false, canGoForward: false };
        tabs = [...tabs, t]; active = t.id; push(); return t;
      },
      close: async (id) => { tabs = tabs.filter((t) => t.id !== id); active = tabs[0]?.id ?? 0; push(); },
      activate: async (id) => { active = id; push(); },
      navigate: async (id, input) => { tabs = tabs.map((t) => (t.id === (id ?? active) ? { ...t, url: input, title: input } : t)); push(); },
      back: noop, forward: noop, reload: noop,
      setProfile: async (id, profileId) => { tabs = tabs.map((t) => (t.id === (id ?? active) ? { ...t, profileId } : t)); push(); return tabs[0]; },
      showFirefox: noop,
    },
    engine: { status: async () => ({ firefoxInstalled: false, defaultEngine: 'chromium' }), installFirefox: async () => false },
    setPageBounds: noop,
    previewTemplate: async (str) => ({ text: str }),
    profiles: { refresh: noop, clearData: async () => true },
    settings: { refresh: noop },
    recorder: {
      start: async () => fire('rec:state', { recording: true, mode: 'record', url: tabs.find((t) => t.id === active)?.url }),
      stop: async () => fire('rec:state', { recording: false }),
      setMode: async (mode) => fire('rec:state', { recording: true, mode }),
    },
    runner: { run: async () => [], stop: noop, resume: async () => false },
    openExternal: async (u) => { window.open(u, '_blank'); },
    saveFile: async ({ name, content, base64 }) => {
      const a = document.createElement('a');
      const data = base64 ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : content;
      a.href = URL.createObjectURL(new Blob([data]));
      a.download = name; a.click(); return name;
    },
    on(ch, cb) {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(cb);
      return () => listeners.get(ch)!.delete(cb);
    },
  };
}

let cached: Bridge | null = null;
export function bridge(): Bridge {
  if (cached) return cached;
  const w = typeof window !== 'undefined' ? (window as any) : null;
  cached = w && w.autobrowser ? (w.autobrowser as Bridge) : mockBridge();
  return cached;
}
