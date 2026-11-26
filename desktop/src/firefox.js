// Firefox engine (optional, per account).
//
// Electron can only embed Chromium, so Firefox runs as its own window, driven
// through Playwright's Firefox build. To keep the recorder, runner and private
// mode identical for both engines, each Firefox page is wrapped in an object
// that looks like an Electron `webContents` (the subset the app uses), and the
// same page script (preload-page.js) is injected with a tiny shim in place of
// Electron's ipcRenderer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

let playwright = null;
function pw() {
  if (!playwright) playwright = require('playwright-core');
  return playwright;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- page script + shim
function pageScript(bindingName, dispatchKey) {
  const preload = fs.readFileSync(path.join(__dirname, 'preload-page.js'), 'utf8');
  // Runs in every frame before the site's own scripts.
  return `(() => {
  if (window[Symbol.for(${JSON.stringify(dispatchKey)})]) return;
  // Playwright installs the bridge function after init scripts in Firefox, so look it up lazily.
  const NAME = ${JSON.stringify(bindingName)};
  let bridge = null;
  const call = async (...a) => {
    for (let i = 0; !bridge && i < 100; i++) {
      if (typeof window[NAME] === 'function') {
        bridge = window[NAME];
        try { Object.defineProperty(window, NAME, { value: bridge, enumerable: false, configurable: true, writable: true }); } catch (e) {}
      } else await new Promise((r) => setTimeout(r, 20));
    }
    if (!bridge) throw new Error('bridge unavailable');
    return bridge(...a);
  };
  const listeners = {};
  Object.defineProperty(window, Symbol.for(${JSON.stringify(dispatchKey)}), {
    value: (channel, payload) => (listeners[channel] || []).forEach((fn) => { try { fn({}, payload); } catch (e) {} }),
  });
  const ipcRenderer = {
    send: (channel, ...args) => { call('send', channel, args).catch(() => {}); },
    invoke: (channel, ...args) => call('invoke', channel, args),
    sendSync: (channel) => (channel === 'page:stealth-config' ? { engine: 'firefox' } : null),
    on: (channel, fn) => { (listeners[channel] = listeners[channel] || []).push(fn); },
  };
  const contextBridge = { executeInMainWorld: ({ func, args }) => func(...(args || [])) };
  const webFrame = { executeJavaScript: () => Promise.resolve() };
  const electronShim = { ipcRenderer, contextBridge, webFrame };
  ((require) => {
${preload}
  })(() => electronShim);
})();`;
}

// ---------------------------------------------------------------- webContents look-alike
class FrameAdapter {
  constructor(engine, frame) { this.engine = engine; this.frame = frame; }
  get url() { return this.frame.url(); }
  get name() { return this.frame.name(); }
  get parent() { const p = this.frame.parentFrame(); return p ? this.engine.frameAdapter(p) : null; }
  get framesInSubtree() {
    const out = [];
    const walk = (f) => { out.push(this.engine.frameAdapter(f)); f.childFrames().forEach(walk); };
    walk(this.frame);
    return out;
  }
  send(channel, payload) {
    this.frame.evaluate(([key, c, p]) => { const d = window[Symbol.for(key)]; if (d) d(c, p); }, [this.engine.dispatchKey, channel, payload]).catch(() => {});
  }
}

const KEYS = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
const MODS = { control: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' };

class PageAdapter extends EventEmitter {
  constructor(engine, page) {
    super();
    this.engine = engine;
    this.page = page;
    this.loading = false;
    this.closed = false;
    this.chain = Promise.resolve();
    this.history = { index: 0, length: 1 };
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      this.loading = true;
      this.emit('did-start-navigation');
      this.emit('did-navigate', {}, f.url());
    });
    page.on('load', () => {
      this.loading = false;
      this.emit('did-stop-loading');
      page.title().then((t) => { this.title = t; this.emit('page-title-updated'); }).catch(() => {});
    });
    page.on('close', () => { this.closed = true; this.emit('destroyed'); });
    page.on('popup', (p) => { if (engine.hooks.onPopup) engine.hooks.onPopup(this, engine.pageAdapter(p)); });
    page.on('download', (d) => {
      const want = this.pendingDownload;
      if (want) { this.pendingDownload = null; want(d); return; }
      if (engine.hooks.onDownload) engine.hooks.onDownload(this, d);
    });
    const self = this;
    this.navigationHistory = {
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: () => self.page.goBack().catch(() => {}),
      goForward: () => self.page.goForward().catch(() => {}),
    };
  }

  get mainFrame() { return this.engine.frameAdapter(this.page.mainFrame()); }
  getURL() { return this.closed ? '' : this.page.url(); }
  getTitle() { return this.title || ''; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.closed; }
  async loadURL(url) {
    this.loading = true;
    try { await this.page.goto(url, { waitUntil: 'load', timeout: 60000 }); } finally { this.loading = false; }
    this.title = await this.page.title().catch(() => '');
  }
  reload() { return this.page.reload().catch(() => {}); }
  close() { return this.page.close().catch(() => {}); }
  focus() { return this.page.bringToFront().catch(() => {}); }
  toggleDevTools() {}
  /** Next download from this page is saved at pathFor(suggestedName). */
  expectDownload(pathFor, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingDownload = null; reject(new Error('no download started')); }, timeout);
      this.pendingDownload = (d) => {
        clearTimeout(timer);
        const target = pathFor(d.suggestedFilename());
        d.saveAs(target).then(() => resolve(target), reject);
      };
    });
  }

  setInputFiles(frameAdapter, selector, paths) {
    return frameAdapter.frame.setInputFiles(selector, paths);
  }

  /** Resolves when all queued mouse / keyboard events have been delivered. */
  flushInput() { return this.chain; }

  // Electron-style input events -> Playwright input (Firefox treats them as trusted).
  sendInputEvent(ev) {
    const m = this.page.mouse;
    const k = this.page.keyboard;
    const mods = (ev.modifiers || []).map((x) => MODS[x]).filter(Boolean);
    const run = async () => {
      switch (ev.type) {
        case 'mouseMove': return m.move(ev.x, ev.y);
        case 'mouseDown': return m.down({ button: ev.button || 'left', clickCount: ev.clickCount || 1 });
        case 'mouseUp': return m.up({ button: ev.button || 'left', clickCount: ev.clickCount || 1 });
        case 'mouseWheel': return m.wheel(0, -(ev.deltaY || 0));
        case 'keyDown': {
          for (const mod of mods) if (mod !== 'Shift' || ev.keyCode.length !== 1) await k.down(mod);
          return k.down(KEYS[ev.keyCode] || ev.keyCode);
        }
        case 'keyUp': {
          await k.up(KEYS[ev.keyCode] || ev.keyCode);
          for (const mod of mods.reverse()) if (mod !== 'Shift' || ev.keyCode.length !== 1) await k.up(mod);
          return undefined;
        }
        default: return undefined; // 'char' is produced by keyDown in Playwright
      }
    };
    this.chain = this.chain.then(run).catch(() => {});
  }

  async capturePage() {
    await this.chain;
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 70 });
    return {
      getSize: () => ({ width: 1280, height: 800 }),
      resize: function () { return this; },
      toJPEG: () => buf,
    };
  }
}

// ---------------------------------------------------------------- engine
class FirefoxEngine {
  constructor({ browsersPath, profilesPath, hooks }) {
    this.browsersPath = browsersPath;
    this.profilesPath = profilesPath;
    this.hooks = hooks; // { onSend(adapter, frameAdapter, channel, args), onInvoke(adapter, channel, args) }
    this.contexts = new Map(); // profileKey -> Promise<BrowserContext>
    this.frames = new WeakMap();
    this.pages = new WeakMap();
    this.bindingName = `__ab_${crypto.randomBytes(5).toString('hex')}`;
    this.dispatchKey = `ab.${crypto.randomBytes(5).toString('hex')}`;
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }

  frameAdapter(f) {
    if (!this.frames.has(f)) this.frames.set(f, new FrameAdapter(this, f));
    return this.frames.get(f);
  }

  pageAdapter(p) {
    if (!this.pages.has(p)) this.pages.set(p, new PageAdapter(this, p));
    return this.pages.get(p);
  }

  installed() {
    try { return fs.existsSync(pw().firefox.executablePath()); } catch { return false; }
  }

  /** Downloads Playwright's Firefox build (~95 MB) into the app's data folder. */
  install(onLine = () => {}) {
    return new Promise((resolve, reject) => {
      // cli.js is not in the package's "exports", so find it next to the main entry;
      // in the packaged app it lives in app.asar.unpacked (see asarUnpack in package.json).
      const cli = path.join(path.dirname(require.resolve('playwright-core')), 'cli.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const child = spawn(process.execPath, [cli, 'install', 'firefox'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: this.browsersPath },
        windowsHide: true,
      });
      const feed = (d) => String(d).split(/\r|\n/).map((l) => l.trim()).filter(Boolean).forEach(onLine);
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 && this.installed() ? resolve(true) : reject(new Error(`Firefox download failed (exit ${code})`))));
    });
  }

  async context(profileId, profile, locale) {
    const key = profileId || 'default';
    if (!this.contexts.has(key)) {
      const p = (async () => {
        if (!this.installed()) throw new Error('The Firefox engine is not installed yet (Settings → Browser engine).');
        const dir = path.join(this.profilesPath, key);
        fs.mkdirSync(dir, { recursive: true });
        const proxy = parseProxy(profile && profile.proxy);
        const ctx = await pw().firefox.launchPersistentContext(dir, {
          headless: false,
          viewport: null,
          locale,
          proxy: proxy || undefined,
          acceptDownloads: true,
          firefoxUserPrefs: {
            'dom.webdriver.enabled': false,
            'pdfjs.disabled': false,
            'marionette.enabled': false,
            'browser.shell.checkDefaultBrowser': false,
          },
        });
        await ctx.exposeBinding(this.bindingName, async (source, kind, channel, args) => {
          const adapter = this.pageAdapter(source.page);
          if (kind === 'invoke') return this.hooks.onInvoke(adapter, channel, args || []);
          this.hooks.onSend(adapter, this.frameAdapter(source.frame), channel, args || []);
          return null;
        });
        await ctx.addInitScript({ content: pageScript(this.bindingName, this.dispatchKey) });
        ctx.on('close', () => this.contexts.delete(key));
        return ctx;
      })();
      this.contexts.set(key, p);
      p.catch(() => this.contexts.delete(key));
    }
    return this.contexts.get(key);
  }

  /** Opens a page (tab in the Firefox window) and returns its webContents look-alike. */
  async openPage(profileId, profile, locale, url) {
    const ctx = await this.context(profileId, profile, locale);
    const blank = ctx.pages().find((p) => p.url() === 'about:blank' && !this.pages.has(p));
    const page = blank || await ctx.newPage();
    const adapter = this.pageAdapter(page);
    if (url) adapter.loadURL(url).catch(() => {});
    return adapter;
  }

  async closeAll() {
    for (const p of this.contexts.values()) {
      try { (await p).close(); } catch {}
    }
    this.contexts.clear();
  }
}

function parseProxy(proxy) {
  if (!proxy) return null;
  try {
    const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  } catch { return null; }
}

module.exports = { FirefoxEngine, sleep };
