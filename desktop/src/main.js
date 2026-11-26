// AutoBrowser — Electron main process.
//
// Window layout: one WebContentsView renders the Next.js UI (glass chrome,
// panels) across the whole window; the active tab's WebContentsView floats on
// top inside the rectangle the UI reports via `ui:page-bounds`.
const { app, BaseWindow, WebContentsView, ipcMain, session, protocol, net, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { startBackend } = require('./backend');
const { identity } = require('./stealth');
const { Runner } = require('./runner');
const { FirefoxEngine } = require('./firefox');

const DEV = !!process.env.AB_DEV;
if (process.env.AB_USER_DATA) app.setPath('userData', process.env.AB_USER_DATA);
const UI_DEV_URL = process.env.AB_UI_URL || 'http://localhost:3000';
const UI_ORIGIN = 'app://autobrowser';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Look like a normal Chrome install to every site, from the first request.
const ID = identity(app.getLocale && app.getLocale() ? app.getLocale() : 'en-US');
app.userAgentFallback = ID.userAgent;
// Do not advertise automation; keep the GPU/WebGL stack as in stock Chrome.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('lang', ID.languages[0]);

let win = null;
let uiView = null;
let backend = null;
let settings = { human_speed: 1, stealth: true };
let profiles = new Map(); // id -> profile (from backend)
const tabs = new Map(); // tabId -> {id, view, profileId, partition, title, url, favicon, loading}
let activeTabId = null;
let nextTabId = 1;
let pageBounds = null;
let recording = null; // {tabId, mode}
const configuredSessions = new Set();
let firefox = null; // optional Firefox engine (separate window)

// ------------------------------------------------------------------ backend api
async function api(method, p, body) {
  const res = await net.fetch(`http://127.0.0.1:${backend.port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-autobrowser-token': backend.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.detail) || `${res.status} ${res.statusText}`);
  return data;
}

async function refreshProfiles() {
  try {
    const list = await api('GET', '/profiles');
    profiles = new Map(list.map((p) => [p.id, p]));
    for (const p of list) configureSession(partitionFor(p.id), p);
  } catch (e) { console.error('profiles', e.message); }
}

async function refreshSettings() {
  try { settings = await api('GET', '/settings'); } catch {}
}

// ------------------------------------------------------------------ sessions
function partitionFor(profileId) {
  return profileId ? `persist:ab_${profileId}` : 'persist:ab_default';
}

function parseProxy(proxy) {
  if (!proxy) return null;
  try {
    const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    const scheme = u.protocol.replace(':', '');
    return {
      rules: `${scheme === 'https' ? 'https' : scheme}://${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      host: u.hostname,
    };
  } catch { return null; }
}

function configureSession(partition, profile) {
  const ses = session.fromPartition(partition);
  const proxy = parseProxy(profile && profile.proxy);
  ses.setProxy(proxy ? { proxyRules: proxy.rules, proxyBypassRules: '<local>' } : { mode: 'system' }).catch(() => {});
  ses.__abProxy = proxy;
  if (configuredSessions.has(partition)) return ses;
  configuredSessions.add(partition);

  ses.setUserAgent(ID.userAgent, ID.acceptLanguage);
  ses.setSpellCheckerLanguages ? ses.setSpellCheckerLanguages([ID.languages[0]]) : null;

  // Keep client-hint headers consistent with the UA (Electron would otherwise
  // omit the "Google Chrome" brand).
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'sec-ch-ua') h[k] = ID.secChUa;
      else if (lk === 'sec-ch-ua-full-version-list') h[k] = ID.secChUaFull;
      else if (lk === 'sec-ch-ua-platform') h[k] = `"${ID.platform}"`;
      else if (lk === 'sec-ch-ua-platform-version') h[k] = ID.platformVersion;
    }
    cb({ requestHeaders: h });
  });

  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'notifications', 'media', 'geolocation'].includes(permission));
  });

  ses.on('will-download', (_e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
    item.once('done', (_ev, state) => sendUI('download:done', { file: item.getSavePath(), state }));
  });
  return ses;
}

app.on('login', (event, _wc, details, authInfo, cb) => {
  if (!authInfo.isProxy) return;
  for (const p of configuredSessions) {
    const pr = session.fromPartition(p).__abProxy;
    if (pr && pr.host === authInfo.host && pr.username) {
      event.preventDefault();
      cb(pr.username, pr.password);
      return;
    }
  }
});

// ------------------------------------------------------------------ UI <-> main
function sendUI(channel, payload) {
  if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send(channel, payload);
}

function tabInfo(t) {
  return { id: t.id, engine: t.engine || 'chromium', profileId: t.profileId, title: t.title, url: t.url, favicon: t.favicon, loading: t.loading, canGoBack: t.view.webContents.navigationHistory.canGoBack(), canGoForward: t.view.webContents.navigationHistory.canGoForward() };
}

function pushTabs() {
  sendUI('tabs:update', { tabs: [...tabs.values()].map(tabInfo), activeTabId });
}

function layout() {
  if (!win) return;
  const b = win.getContentBounds();
  uiView.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  for (const t of tabs.values()) {
    const show = t.id === activeTabId && pageBounds && t.url && !t.view.external;
    t.view.setVisible(!!show);
    if (show) t.view.setBounds(pageBounds);
  }
}

// ------------------------------------------------------------------ tabs
function engineFor(profileId) {
  const p = profiles.get(profileId);
  return (p && p.engine) || settings.default_engine || 'chromium';
}

function createTab(opts = {}) {
  return engineFor(opts.profileId ?? null) === 'firefox' ? createFirefoxTab(opts) : createChromiumTab(opts);
}

// A tab whose page lives in the Firefox window. `view.webContents` is a look-alike
// (see firefox.js), so recording, running and private mode work the same way.
async function createFirefoxTab({ url, profileId = null, activate = true } = {}) {
  const wc = await firefox.openPage(profileId, profiles.get(profileId), ID.languages[0], url || null);
  for (const t of tabs.values()) if (t.view.webContents === wc) return t;
  const id = nextTabId++;
  const view = { external: true, webContents: wc, setVisible() {}, setBounds() {} };
  const tab = { id, view, engine: 'firefox', profileId, title: url ? 'Loading…' : 'New tab', url: url || '', favicon: null, loading: !!url };
  tabs.set(id, tab);
  const upd = () => { tab.url = wc.getURL() === 'about:blank' ? '' : wc.getURL(); tab.title = wc.getTitle() || tab.url || 'New tab'; pushTabs(); layout(); };
  wc.on('page-title-updated', upd);
  wc.on('did-start-navigation', () => { tab.loading = true; pushTabs(); });
  wc.on('did-stop-loading', () => { tab.loading = false; upd(); });
  wc.on('did-navigate', (_e, u) => {
    upd();
    if (recording && recording.tabId === id && u !== 'about:blank') sendUI('rec:navigated', { tabId: id, url: u, ts: Date.now() });
  });
  wc.on('destroyed', () => {
    if (!tabs.has(id)) return;
    if (recording && recording.tabId === id) stopRecording();
    tabs.delete(id);
    if (activeTabId === id) activeTabId = [...tabs.keys()].pop() ?? null;
    if (!tabs.size) createTab({ profileId: null });
    layout(); pushTabs();
  });
  if (activate) activateTab(id); else layout();
  pushTabs();
  return tab;
}

function createChromiumTab({ url, profileId = null, activate = true } = {}) {
  const partition = partitionFor(profileId);
  configureSession(partition, profiles.get(profileId));
  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload-page.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // runs the preload (recorder) in iframes too
      plugins: true, // built-in PDF viewer, like Chrome
      spellcheck: true,
      backgroundThrottling: false, // keep automations running in background tabs
    },
  });
  if (view.setBorderRadius) view.setBorderRadius(14);
  view.setBackgroundColor('#ffffff');
  const id = nextTabId++;
  const tab = { id, view, profileId, partition, title: 'New tab', url: '', favicon: null, loading: false };
  tabs.set(id, tab);
  win.contentView.addChildView(view);
  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url: u }) => {
    createTab({ url: u, profileId, activate: true });
    return { action: 'deny' };
  });
  const upd = () => { tab.url = wc.getURL(); tab.title = wc.getTitle() || tab.url; pushTabs(); layout(); };
  wc.on('page-title-updated', upd);
  wc.on('did-start-loading', () => { tab.loading = true; pushTabs(); });
  wc.on('did-stop-loading', () => { tab.loading = false; upd(); });
  wc.on('did-navigate-in-page', upd);
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] || null; pushTabs(); });
  wc.on('did-navigate', (_e, u) => {
    upd();
    if (recording && recording.tabId === id) sendUI('rec:navigated', { tabId: id, url: u, ts: Date.now() });
  });
  wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
    if (isMain && code !== -3) sendUI('tabs:error', { tabId: id, code, desc, url: u });
  });
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') wc.toggleDevTools();
    if ((input.control || input.meta) && input.key.toLowerCase() === 'l') sendUI('ui:focus-address', {});
    if ((input.control || input.meta) && input.key.toLowerCase() === 't') sendUI('ui:new-tab', {});
  });
  wc.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate([
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      ...(params.linkURL ? [{ label: 'Open link in new tab', click: () => createTab({ url: params.linkURL, profileId }) }] : []),
      { role: 'copy', enabled: !!params.selectionText },
      { role: 'paste', enabled: params.isEditable },
      { type: 'separator' },
      { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) },
    ]).popup();
  });

  if (url) wc.loadURL(url).catch(() => {});
  tab.url = url || '';
  if (activate) activateTab(id); else layout();
  pushTabs();
  return tab;
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  // bring to front
  const t = tabs.get(id);
  if (t.view.external) t.view.webContents.focus();
  else {
    win.contentView.removeChildView(t.view);
    win.contentView.addChildView(t.view);
  }
  layout();
  pushTabs();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (recording && recording.tabId === id) stopRecording();
  tabs.delete(id);
  if (!t.view.external) win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (activeTabId === id) {
    const rest = [...tabs.keys()];
    activeTabId = rest.length ? rest[rest.length - 1] : null;
  }
  if (!tabs.size) createTab({});
  layout();
  pushTabs();
}

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^(https?|file|about|data):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

// ------------------------------------------------------------------ recorder
function broadcastMode(tabId, mode) {
  const t = tabs.get(tabId);
  if (!t) return;
  for (const f of t.view.webContents.mainFrame.framesInSubtree) {
    try { f.send('rec:mode', mode); } catch {}
  }
}

function startRecording(tabId) {
  if (recording) broadcastMode(recording.tabId, 'off');
  recording = { tabId, mode: 'record' };
  broadcastMode(tabId, 'record');
  const t = tabs.get(tabId);
  sendUI('rec:state', { recording: true, tabId, mode: 'record', url: t ? t.view.webContents.getURL() : '', profileId: t && t.profileId });
}

function stopRecording() {
  if (!recording) return;
  broadcastMode(recording.tabId, 'off');
  sendUI('rec:state', { recording: false });
  recording = null;
}

ipcMain.on('rec:step', (e, step) => {
  if (!recording) return;
  const t = tabs.get(recording.tabId);
  if (!t || e.sender !== t.view.webContents) return;
  const frame = e.senderFrame;
  if (frame && frame !== t.view.webContents.mainFrame && step.target) step.target.frame = frame.url;
  if (recording.mode.startsWith('pick-') && step.type !== 'notice') {
    // one pick per click, then go back to normal recording
    recording.mode = 'record';
    broadcastMode(recording.tabId, 'record');
    sendUI('rec:state', { recording: true, tabId: recording.tabId, mode: 'record' });
  }
  sendUI('rec:step', step);
});

function recModeFor(sender) {
  if (!recording) return 'off';
  const t = tabs.get(recording.tabId);
  return t && sender === t.view.webContents ? recording.mode : 'off';
}
ipcMain.handle('rec:get-mode', (e) => recModeFor(e.sender));

ipcMain.on('page:stealth-config', (e) => {
  e.returnValue = settings.stealth === false ? null : {
    brands: ID.brands, fullVersionList: ID.fullVersionList, platform: ID.platform,
    platformVersion: ID.platformVersion, languages: ID.languages, hardwareConcurrency: ID.hardwareConcurrency,
  };
});

// ------------------------------------------------------------------ runner
let runner = null;

async function tabForProfile(profileId) {
  // Reuse an open tab of this profile, otherwise open a new one (in the background).
  for (const t of tabs.values()) {
    if (t.profileId === profileId && !(recording && recording.tabId === t.id)) {
      activateTab(t.id);
      return t;
    }
  }
  if (profileId && !profiles.has(profileId)) await refreshProfiles();
  return await createTab({ url: 'about:blank', profileId, activate: true });
}

// ------------------------------------------------------------------ IPC from UI
function fromUI(e) { return uiView && e.sender === uiView.webContents; }
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromUI(e)) throw new Error('forbidden');
    return fn(...args);
  });
}

handle('backend:info', () => ({ port: backend.port, token: backend.token, platform: process.platform, chrome: process.versions.chrome, version: app.getVersion() }));
handle('tabs:list', () => ({ tabs: [...tabs.values()].map(tabInfo), activeTabId }));
handle('tabs:create', async ({ url, profileId } = {}) => tabInfo(await createTab({ url: normalizeUrl(url), profileId })));
handle('tabs:close', (id) => closeTab(id));
handle('tabs:activate', (id) => activateTab(id));
handle('tabs:navigate', (id, input) => {
  const t = tabs.get(id ?? activeTabId);
  if (!t) return;
  const u = normalizeUrl(input);
  if (!u) return;
  t.url = u;
  t.view.webContents.loadURL(u).catch(() => {});
  if (t.view.external) t.view.webContents.focus();
  layout();
});
handle('tabs:back', (id) => { const t = tabs.get(id ?? activeTabId); if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); });
handle('tabs:forward', (id) => { const t = tabs.get(id ?? activeTabId); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); });
handle('tabs:reload', (id) => { const t = tabs.get(id ?? activeTabId); if (t) t.view.webContents.reload(); });
handle('tabs:set-profile', async (id, profileId) => {
  // Profiles are isolated cookie jars; switching means reopening the URL in a new tab.
  const t = tabs.get(id ?? activeTabId);
  await refreshProfiles();
  const url = t ? t.view.webContents.getURL() : '';
  const nt = await createTab({ url: url === 'about:blank' ? '' : url, profileId });
  if (t) closeTab(t.id);
  return tabInfo(nt);
});
handle('ui:page-bounds', (rect) => {
  pageBounds = rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) } : null;
  layout();
});
handle('profiles:refresh', () => refreshProfiles());
handle('profiles:clear-data', async (profileId) => {
  const ses = session.fromPartition(partitionFor(profileId));
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
});
handle('settings:refresh', () => refreshSettings());
handle('rec:start', (tabId) => startRecording(tabId ?? activeTabId));
handle('rec:stop', () => stopRecording());
handle('rec:mode', (mode) => {
  if (!recording) return;
  recording.mode = mode;
  broadcastMode(recording.tabId, mode);
  sendUI('rec:state', { recording: true, tabId: recording.tabId, mode });
});
handle('runner:run', (opts) => runner.runMany(opts));
handle('engine:status', () => ({ firefoxInstalled: !!(firefox && firefox.installed()), defaultEngine: settings.default_engine || 'chromium' }));
handle('engine:install-firefox', async () => {
  if (firefox.installed()) return true;
  await firefox.install((line) => sendUI('engine:progress', { line }));
  return true;
});
handle('tabs:show-firefox', (id) => { const t = tabs.get(id ?? activeTabId); if (t && t.view.external) t.view.webContents.focus(); });
handle('runner:stop', (runId) => runner.stop(runId));
handle('shell:open', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
handle('file:save', async ({ name, content, base64 }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, base64 ? Buffer.from(content, 'base64') : content);
  return r.filePath;
});

// ------------------------------------------------------------------ app lifecycle
function serveUI() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app-ui') : path.resolve(__dirname, '..', '..', 'frontend', 'out');
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = path.join(root, rel);
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    if (!fs.existsSync(file)) file = path.join(root, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

async function createWindow() {
  win = new BaseWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'AutoBrowser',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#00000000', symbolColor: '#3a3f4b', height: 44 },
    backgroundColor: '#dfe9ee',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });
  uiView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  uiView.setBackgroundColor('#00000000');
  win.contentView.addChildView(uiView);
  uiView.webContents.loadURL(DEV ? UI_DEV_URL : `${UI_ORIGIN}/`);
  uiView.webContents.setWindowOpenHandler(({ url }) => { createTab({ url }); return { action: 'deny' }; });
  uiView.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEV) uiView.webContents.openDevTools({ mode: 'detach' });
  win.on('resize', layout);
  win.on('closed', () => { win = null; });
  layout();
  createTab({});
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  serveUI();
  try {
    backend = await startBackend(app);
  } catch (e) {
    dialog.showErrorBox('AutoBrowser backend failed to start', String(e.message || e));
    app.quit();
    return;
  }
  await Promise.all([refreshProfiles(), refreshSettings()]);
  configureSession(partitionFor(null), null);
  firefox = new FirefoxEngine({
    browsersPath: process.env.AB_BROWSERS || path.join(app.getPath('userData'), 'browsers'),
    profilesPath: path.join(app.getPath('userData'), 'firefox-profiles'),
    hooks: {
      // page script -> main (same channels as the Chromium preload uses)
      onSend: (wc, frame, channel, args) => ipcMain.emit(channel, { sender: wc, senderFrame: frame, returnValue: null }, ...args),
      onInvoke: (wc, channel) => (channel === 'rec:get-mode' ? recModeFor(wc) : null),
    },
  });
  if (process.env.AB_TEST) global.__abTest = { tabs, get firefox() { return firefox; } }; // end-to-end tests only
  runner = new Runner({
    tabForProfile,
    api,
    emit: sendUI,
    speed: () => Number(settings.human_speed) || 1,
    privacy: () => settings.privacy_mode !== false,
  });
  await createWindow();
});

app.on('window-all-closed', () => {
  if (backend) backend.stop();
  app.quit();
});
app.on('before-quit', () => { if (backend) backend.stop(); if (firefox) firefox.closeAll(); });
