// Preload for every web page (and sub-frame) shown in a tab.
//
// Runs in an *isolated world*: page scripts cannot see anything defined here.
// Three jobs:
//   1. Stealth patches in the page's main world (before any page script runs).
//   2. Recorder: turns your clicks / typing / picks into flow steps.
//   3. DOM engine for the runner: locate elements, extract tables, snapshots.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

// ---------------------------------------------------------------- 1. stealth
function stealthPatch(cfg) {
  try {
    const firefox = cfg.engine === 'firefox';
    const nativeToString = Function.prototype.toString;
    const fake = new WeakMap();
    const nativeText = (name) => (firefox ? `function ${name.replace(/^get /, '')}() {\n    [native code]\n}` : `function ${name}() { [native code] }`);
    const mark = (fn, name) => { fake.set(fn, nativeText(name)); return fn; };
    const toStringProxy = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        if (fake.has(thisArg)) return fake.get(thisArg);
        return Reflect.apply(target, thisArg, args);
      },
    });
    fake.set(toStringProxy, nativeText('toString'));
    Function.prototype.toString = toStringProxy;

    const getter = (obj, prop, value) => {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      Object.defineProperty(obj, prop, {
        get: mark(function () { return value; }, `get ${prop}`),
        configurable: true,
        enumerable: d ? d.enumerable : true,
      });
    };

    getter(Navigator.prototype, 'webdriver', false);
    if (firefox) return; // Firefox already looks like Firefox; only the automation flag needs hiding
    getter(Navigator.prototype, 'languages', Object.freeze(cfg.languages.slice()));
    getter(Navigator.prototype, 'hardwareConcurrency', cfg.hardwareConcurrency);

    if (navigator.userAgentData) {
      const proto = Object.getPrototypeOf(navigator.userAgentData);
      const brands = () => cfg.brands.map((b) => ({ brand: b.brand, version: b.version }));
      getter(proto, 'brands', Object.freeze(brands().map(Object.freeze)));
      getter(proto, 'platform', cfg.platform);
      const origHigh = proto.getHighEntropyValues;
      proto.getHighEntropyValues = mark(function getHighEntropyValues(hints) {
        return origHigh.call(this, hints).then((v) => {
          if ('brands' in v) v.brands = brands();
          if ('fullVersionList' in v) v.fullVersionList = cfg.fullVersionList.map((b) => ({ ...b }));
          if ('platform' in v) v.platform = cfg.platform;
          if ('platformVersion' in v) v.platformVersion = cfg.platformVersion.replace(/"/g, '');
          if ('uaFullVersion' in v) v.uaFullVersion = cfg.fullVersionList[0].version;
          return v;
        });
      }, 'getHighEntropyValues');
      const origJSON = proto.toJSON;
      if (origJSON) {
        proto.toJSON = mark(function toJSON() {
          const o = origJSON.call(this);
          o.brands = brands();
          o.platform = cfg.platform;
          return o;
        }, 'toJSON');
      }
    }

    // Stock Chrome exposes window.chrome; Electron does not.
    if (!window.chrome) {
      const start = Date.now() / 1000;
      const chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: mark(function getDetails() { return null; }, 'getDetails'),
          getIsInstalled: mark(function getIsInstalled() { return false; }, 'getIsInstalled'),
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        },
        loadTimes: mark(function loadTimes() {
          return { requestTime: start, startLoadTime: start, commitLoadTime: start + 0.1, finishDocumentLoadTime: start + 0.3,
            finishLoadTime: start + 0.5, firstPaintTime: start + 0.35, firstPaintAfterLoadTime: 0, navigationType: 'Other',
            wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
        }, 'loadTimes'),
        csi: mark(function csi() { return { startE: start * 1000, onloadT: start * 1000 + 500, pageT: performance.now(), tran: 15 }; }, 'csi'),
      };
      Object.defineProperty(window, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true });
    }

    // Notification permission must agree with permissions.query (classic headless tell).
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      Permissions.prototype.query = mark(function query(p) {
        if (p && p.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission === 'default' ? 'prompt' : Notification.permission, onchange: null });
        }
        return origQuery(p);
      }, 'query');
    }
  } catch (_) { /* never break the page */ }
}

const stealthCfg = ipcRenderer.sendSync('page:stealth-config');
if (stealthCfg) {
  if (contextBridge.executeInMainWorld) {
    contextBridge.executeInMainWorld({ func: stealthPatch, args: [stealthCfg] });
  } else {
    webFrame.executeJavaScript(`(${stealthPatch.toString()})(${JSON.stringify(stealthCfg)})`);
  }
}

// ---------------------------------------------------------------- helpers
const MAX_TEXT = 80;
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const short = (s, n = MAX_TEXT) => { s = clean(s); return s.length > n ? s.slice(0, n) : s; };
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
const attrSel = (name, v) => `[${name}="${String(v).replace(/"/g, '\\"')}"]`;
const looksDynamic = (s) => !s || /\d{4,}|[a-f0-9]{8,}|^[0-9]|:r\d|__|ember\d|react-/i.test(s);

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.02;
}

function cssPath(el) {
  const parts = [];
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    if (el.id && !looksDynamic(el.id)) { parts.unshift(`#${cssEsc(el.id)}`); break; }
    let part = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    parts.unshift(part);
    el = parent;
  }
  return parts.join(' > ');
}

function xPath(el) {
  const parts = [];
  while (el && el.nodeType === 1) {
    let i = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
    parts.unshift(`${el.tagName.toLowerCase()}[${i}]`);
    el = el.parentElement;
  }
  return '/' + parts.join('/');
}

function labelOf(el) {
  if (el.labels && el.labels[0]) return short(el.labels[0].innerText);
  const al = el.getAttribute('aria-label'); if (al) return short(al);
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = document.getElementById(lb.split(' ')[0]); if (t) return short(t.innerText); }
  return '';
}

function count(sel, root = document) { try { return root.querySelectorAll(sel).length; } catch { return 0; } }

function buildTarget(el, root = document) {
  const tag = el.tagName.toLowerCase();
  const c = [];
  const add = (kind, value, score) => {
    if (!value) return;
    if (['css', 'testid', 'id', 'name', 'aria', 'placeholder'].includes(kind)) {
      const n = count(value, root);
      if (n === 0) return;
      if (n > 1) score -= 0.3;
    }
    c.push({ kind, value, score: Math.round(score * 100) / 100 });
  };
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id']) {
    const v = el.getAttribute(a); if (v) add('testid', attrSel(a, v), 0.97);
  }
  if (el.id && !looksDynamic(el.id)) add('id', `#${cssEsc(el.id)}`, 0.92);
  const name = el.getAttribute('name'); if (name) add('name', `${tag}${attrSel('name', name)}`, 0.88);
  const aria = el.getAttribute('aria-label'); if (aria) add('aria', `${tag}${attrSel('aria-label', aria)}`, 0.84);
  const ph = el.getAttribute('placeholder'); if (ph) add('placeholder', `${tag}${attrSel('placeholder', ph)}`, 0.8);
  const text = short(el.innerText || el.value || '', 60);
  if (text && ['a', 'button', 'summary', 'label', 'li', 'td', 'span', 'div', 'option'].includes(tag) && text.length <= 60) {
    add('text', `${tag}>>${text}`, 0.7);
  }
  add('css', cssPath(el), 0.55);
  add('xpath', xPath(el), 0.3);
  c.sort((a, b) => b.score - a.score);
  const r = el.getBoundingClientRect();
  return {
    selectors: c,
    tag,
    text: text || undefined,
    label: labelOf(el) || el.getAttribute('placeholder') || el.getAttribute('name') || undefined,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

function queryCandidate(cand, root) {
  try {
    if (cand.kind === 'xpath') {
      const ctx = root === document ? document : root;
      const r = document.evaluate(cand.value, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = []; for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i)); return out;
    }
    if (cand.kind === 'text') {
      const [tag, ...rest] = cand.value.split('>>');
      const want = clean(rest.join('>>')).toLowerCase();
      const els = Array.from(root.querySelectorAll(tag || '*'));
      const exact = els.filter((e) => clean(e.innerText || e.value).toLowerCase() === want);
      return exact.length ? exact : els.filter((e) => clean(e.innerText).toLowerCase().includes(want));
    }
    return Array.from(root.querySelectorAll(cand.value));
  } catch { return []; }
}

function resolveScope(scope) {
  if (!scope || !scope.selector) return document;
  const rows = Array.from(document.querySelectorAll(scope.selector)).filter(isVisible);
  return rows[scope.index] || null;
}

function findElement(target, scope, { allowHidden = false } = {}) {
  const root = resolveScope(scope);
  if (!root || !target) return null;
  for (const cand of target.selectors || []) {
    let c = cand, r = root;
    if (typeof c.value === 'string' && c.value.startsWith('{{row}}')) {
      c = { ...c, value: c.value.replace(/^\{\{row\}\}\s*/, '') };
      if (!c.value) return root;
    } else if (scope && scope.selector && root !== document) {
      // selectors recorded outside the loop still resolve against the document
      r = root.querySelector ? root : document;
      const inside = queryCandidate(c, r).filter(isVisible);
      if (inside.length) return inside[0];
      r = document;
    }
    const found = queryCandidate(c, r);
    const vis = found.filter(isVisible);
    if (vis.length) return vis[0];
    if (found.length && (allowHidden || target.tag === 'input')) return found[0];
  }
  return null;
}

// ---------------------------------------------------------------- tables & lists
function signature(el) { return `${el.tagName}.${(el.classList[0] || '')}`; }

function findRepeatedContainer(el) {
  for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
    const table = cur.closest('table');
    if (table) return { container: table, kind: 'table' };
    const parent = cur.parentElement;
    if (!parent) break;
    const sig = signature(cur);
    const same = Array.from(parent.children).filter((c) => signature(c) === sig);
    if (same.length >= 3) return { container: parent, kind: 'list', rowSig: sig, rowEl: cur };
  }
  return null;
}

// Where a click happened inside a repeated list (table rows, product cards…), so the
// recording can be turned into "do this for every item".
function relPath(root, el) {
  const parts = [];
  for (let cur = el; cur && cur !== root; cur = cur.parentElement) {
    let part = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
  }
  return parts.join(' > ');
}
function listContext(el) {
  try {
    const info = findRepeatedContainer(el);
    if (!info) return null;
    const rowSel = rowSelectorFor(info);
    const rows = rowsOf(info.container, rowSel);
    const row = rows.find((r) => r.contains(el));
    if (!row || rows.length < 2) return null;
    const base = cssPath(info.container);
    const rowSelector = info.kind === 'table' ? `${base} ${rowSel}` : `${base} > ${rowSel.replace(/^:scope >\s*/, '')}`;
    const a = el.closest('a[href]');
    return {
      row_selector: rowSelector,
      index: rows.indexOf(row),
      count: rows.length,
      inner: relPath(row, el),
      link: a && !/^(javascript:|#)/i.test(a.getAttribute('href') || '') ? a.href : null,
      list_url: location.href,
    };
  } catch { return null; }
}

function rowSelectorFor(info) {
  if (info.kind === 'table') return info.container.tBodies.length ? 'tbody > tr' : 'tr';
  const [tag, cls] = info.rowSig.split('.');
  return `:scope > ${tag.toLowerCase()}${cls ? '.' + cssEsc(cls) : ''}`;
}

function cellTexts(row) {
  if (row.tagName === 'TR') return Array.from(row.cells).map((c) => clean(c.innerText));
  const leaves = [];
  const walk = (n) => {
    for (const ch of n.children) {
      if (!isVisible(ch)) continue;
      if (ch.children.length === 0 || ['A', 'BUTTON', 'P', 'H1', 'H2', 'H3', 'H4', 'SPAN', 'TIME'].includes(ch.tagName) && clean(ch.innerText).length < 200 && ch.querySelectorAll('div').length === 0) {
        const t = clean(ch.innerText); if (t) leaves.push(t);
      } else walk(ch);
    }
  };
  walk(row);
  if (!leaves.length) leaves.push(clean(row.innerText));
  return leaves;
}

function tableHeaders(container, kind, firstRowLen) {
  if (kind === 'table') {
    const th = container.tHead ? Array.from(container.tHead.querySelectorAll('th,td')) : Array.from(container.querySelectorAll('tr:first-child th'));
    const names = th.map((h) => clean(h.innerText));
    if (names.length && names.some(Boolean)) return names.map((n, i) => n || `col_${i + 1}`);
  }
  return Array.from({ length: firstRowLen }, (_, i) => `col_${i + 1}`);
}

function rowObject(row, columns) {
  const cells = cellTexts(row);
  const o = {};
  columns.forEach((c, i) => { o[c] = cells[i] ?? ''; });
  cells.slice(columns.length).forEach((v, i) => { o[`col_${columns.length + i + 1}`] = v; });
  const a = row.querySelector('a[href]'); if (a) o._link = a.href;
  return o;
}

function rowsOf(container, rowSelector) {
  try { return Array.from(container.querySelectorAll(rowSelector)).filter((r) => isVisible(r) && clean(r.innerText)); } catch { return []; }
}

function describeTable(container, kind, rowSelector) {
  const rows = rowsOf(container, rowSelector);
  const columns = tableHeaders(container, kind, rows[0] ? cellTexts(rows[0]).length : 1);
  return { rows, columns };
}

// ---------------------------------------------------------------- code-only page outline
// "What the AI may see" in private mode: the page's structure (tags, ids, classes,
// names, roles, field labels, column headers, button captions) with every piece of
// data replaced by its *shape*:  "John Smith 2024-05-01" -> "Xxxx Xxxxx 9999-99-99".
function maskText(s, max = 40) {
  s = clean(s);
  if (!s) return '';
  const m = s.replace(/\p{Nd}|\p{L}/gu, (c) => (/\p{Nd}/u.test(c) ? '9' : /\p{Lu}/u.test(c) ? 'X' : 'x'));
  return m.length > max ? `${m.slice(0, max)}…(${s.length})` : m;
}
const maskUrl = (u) => {
  if (!u) return u;
  try {
    const x = new URL(u, location.href);
    const path = x.pathname.replace(/\d+/g, '9').replace(/[^/]{24,}/g, '…');
    const q = [...x.searchParams.keys()].map((k) => `${k}=…`).join('&');
    return `${x.origin}${path}${q ? `?${q}` : ''}`;
  } catch { return maskText(u); }
};

// Captions that are part of the site's UI, not its data.
function isUiText(el) {
  const tag = el.tagName;
  if (['TH', 'LABEL', 'LEGEND', 'OPTGROUP', 'CAPTION'].includes(tag)) return true;
  if (tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'INPUT' && /submit|button|reset/.test(el.type))) {
    return !el.closest('tbody, [role=row], li li'); // buttons inside data rows may carry data
  }
  if (tag === 'A' && el.closest('nav, header, footer, [role=navigation], .pagination, [aria-label*=pagination i]')) return true;
  return false;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'TEMPLATE', 'LINK', 'META', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'SOURCE', 'BR', 'HR', 'WBR']);
const KEEP_ATTRS = ['name', 'type', 'role', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'for', 'autocomplete', 'method', 'action'];

function ownText(el) {
  let t = '';
  for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
  return clean(t);
}

function describeEl(el, privateMode) {
  const tag = el.tagName.toLowerCase();
  let d = tag;
  if (el.id) d += `#${looksDynamic(el.id) ? el.id.replace(/\d+/g, '9') : el.id}`;
  const cls = Array.from(el.classList).filter((c) => !looksDynamic(c)).slice(0, 3);
  if (cls.length) d += `.${cls.join('.')}`;
  const attrs = [];
  for (const a of KEEP_ATTRS) { const v = el.getAttribute(a); if (v) attrs.push(`${a}="${a === 'action' ? maskUrl(v) : short(v, 40)}"`); }
  const ph = el.getAttribute('placeholder'); if (ph) attrs.push(`placeholder="${short(ph, 40)}"`);
  const al = el.getAttribute('aria-label');
  if (al) attrs.push(`aria-label="${isUiText(el) || /^(INPUT|SELECT|TEXTAREA|NAV)$/.test(el.tagName) ? short(al, 40) : maskText(al)}"`);
  if (tag === 'a' && el.getAttribute('href')) attrs.push(`href="${maskUrl(el.getAttribute('href'))}"`);
  if (/^(input|textarea)$/.test(tag) && el.value && el.type !== 'password') attrs.push(`value="${privateMode ? maskText(el.value) : short(el.value, 40)}"`);
  if (el.disabled) attrs.push('disabled');
  let line = `<${d}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  const t = ownText(el) || (tag === 'option' ? clean(el.text) : '');
  if (t) line += ` "${isUiText(el) ? short(t, 40) : privateMode ? maskText(t) : short(t, 60)}"`;
  return line;
}

const sig = (el) => `${el.tagName}.${el.classList[0] || ''}`;

function pageOutline({ privateMode = true, maxLines = 500 } = {}) {
  const lines = [`URL: ${maskUrl(location.href)}`, `TITLE: ${privateMode ? maskText(document.title, 60) : document.title}`];
  const walk = (el, depth) => {
    if (lines.length >= maxLines || SKIP.has(el.tagName)) return;
    if (el.nodeType !== 1 || (el.checkVisibility && !el.checkVisibility()) ) return;
    const kids = Array.from(el.children);
    // skip pure wrappers (one child, no text, no identifying attributes)
    const wrapper = kids.length === 1 && !ownText(el) && !el.id && !el.getAttribute('role') && !el.getAttribute('name') && !/^(FORM|TABLE|TBODY|THEAD|TR|UL|OL|SELECT|NAV|MAIN)$/.test(el.tagName);
    if (!wrapper) lines.push(`${'  '.repeat(Math.min(depth, 12))}${describeEl(el, privateMode)}`);
    const d = wrapper ? depth : depth + 1;
    for (let i = 0; i < kids.length; i++) {
      // collapse long runs of similar siblings (table rows, list items, cards)
      let j = i;
      while (j + 1 < kids.length && sig(kids[j + 1]) === sig(kids[i])) j++;
      const run = j - i + 1;
      if (run > 3) {
        walk(kids[i], d); walk(kids[i + 1], d);
        lines.push(`${'  '.repeat(Math.min(d, 12))}… ${run - 2} more <${kids[i].tagName.toLowerCase()}${kids[i].classList[0] ? '.' + kids[i].classList[0] : ''}> like the ones above`);
        i = j;
      } else walk(kids[i], d);
    }
  };
  if (document.body) walk(document.body, 0);
  if (lines.length >= maxLines) lines.push('… (outline truncated)');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 2. recorder
let mode = 'off';
let overlay = null;
let hoverBox = null;
let pending = null; // pending text input {el, step}

function ensureOverlay() {
  if (overlay) return;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  hoverBox = document.createElement('div');
  hoverBox.style.cssText = 'position:fixed;border:2px solid #7c5cff;background:rgba(124,92,255,.12);border-radius:6px;transition:all .06s;display:none;box-shadow:0 0 0 4000px rgba(20,20,40,.08)';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:absolute;top:-22px;left:0;font:600 11px system-ui;color:#fff;background:#7c5cff;padding:2px 6px;border-radius:6px;white-space:nowrap';
  hoverBox.appendChild(tag);
  shadow.appendChild(hoverBox);
  (document.documentElement || document).appendChild(host);
  overlay = { host, tag };
}

function removeOverlay() {
  if (overlay) { overlay.host.remove(); overlay = null; hoverBox = null; }
}

function showBox(el, label) {
  if (!el) { if (hoverBox) hoverBox.style.display = 'none'; return; }
  ensureOverlay();
  const r = el.getBoundingClientRect();
  Object.assign(hoverBox.style, { display: 'block', left: `${r.x - 2}px`, top: `${r.y - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  overlay.tag.textContent = label;
}

let outlineSent = false;
function emit(step) {
  step.ts = Date.now();
  step.url = step.url || location.href;
  if (step.type !== 'notice' && (!outlineSent || step.type === 'extract_table')) {
    // masked structure of this page, so the AI build can read the page's code without its data
    try { step.page_outline = pageOutline({ privateMode: true, maxLines: step.type === 'extract_table' ? 500 : 300 }); outlineSent = true; } catch {}
  }
  ipcRenderer.send('rec:step', step);
}

const TEXTY = /^(text|email|password|search|tel|url|number|date|datetime-local|month|week|time)$/;
function isTextInput(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' && TEXTY.test((el.type || 'text').toLowerCase());
}

function templateFor(el, value) {
  const t = (el.type || '').toLowerCase();
  const hints = `${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''} ${el.placeholder || ''}`.toLowerCase();
  if (t === 'password') return { value: '{{account.password}}', secret: true };
  if (/one-time-code|otp|totp|2fa|mfa|verification/.test(hints)) return { value: '{{account.totp}}', secret: true };
  if ((t === 'email' || t === 'text') && /username|email|login|user|e-mail|account/.test(hints)) {
    return { value: '{{account.username}}', sample: value };
  }
  return { value };
}

function flushPending() {
  if (!pending) return;
  const { el, target } = pending;
  pending = null;
  const value = el.isContentEditable ? el.innerText : el.value;
  if (value === undefined) return;
  emit({ type: 'type', target, ...templateFor(el, value) });
}

const CLICKABLE = 'a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],input[type=checkbox],input[type=radio],input[type=submit],input[type=button],label,summary,[onclick],[tabindex]';

// Checkbox-like controls. `control` holds the state, `target` is what you click.
function toggleControl(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) return { control: el, target: el };
  const label = el.closest('label');
  if (label && label.control && /^(checkbox|radio)$/i.test(label.control.type)) return { control: label.control, target: label.control };
  const aria = el.closest('[role=checkbox],[role=switch],[role=radio],[role=menuitemcheckbox]');
  if (aria) return { control: aria, target: aria };
  return null;
}
function isChecked(c) {
  if (!c) return false;
  if (c.tagName === 'INPUT') return !!c.checked;
  return c.getAttribute('aria-checked') === 'true' || c.getAttribute('aria-pressed') === 'true';
}

function onClick(e) {
  if (!e.isTrusted) return;
  const raw = e.composedPath ? e.composedPath()[0] : e.target;
  const el = raw && raw.nodeType === 1 ? raw : e.target;
  if (mode === 'record') {
    if (isTextInput(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    // clicking a file field only opens the system dialog; the chosen file is recorded as an upload step
    if (isFileField(el) || (el.closest('label') && isFileField(el.closest('label').control))) return;
    flushPending();
    const toggle = toggleControl(el);
    if (toggle) {
      // checkbox / radio / switch: record the resulting state, not a blind click
      const tgt = buildTarget(toggle.target);
      setTimeout(() => emit({ type: 'check', target: tgt, value: isChecked(toggle.control) ? 'true' : 'false' }), 60);
      return;
    }
    const t = el.closest(CLICKABLE) || el;
    emit({ type: 'click', target: buildTarget(t), in_list: listContext(t) || undefined });
    return;
  }
  if (mode.startsWith('pick-')) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (mode === 'pick-table') {
      const info = findRepeatedContainer(el);
      if (!info) { emit({ type: 'notice', message: 'No table or repeated list found here — try clicking a row.' }); return; }
      const rowSelector = rowSelectorFor(info);
      const { rows, columns } = describeTable(info.container, info.kind, rowSelector);
      const target = buildTarget(info.container);
      target.row_selector = rowSelector;
      target.columns = columns;
      target.sample = rows.slice(0, 3).map((r) => rowObject(r, columns));
      emit({ type: 'extract_table', target, name: 'table', rowCount: rows.length });
    } else if (mode === 'pick-text') {
      emit({ type: 'extract_text', target: buildTarget(el), name: 'text', sample: short(el.innerText, 200) });
    } else if (mode === 'pick-wait') {
      emit({ type: 'wait', target: buildTarget(el) });
    } else if (mode === 'pick-click') {
      emit({ type: 'click', target: buildTarget(el.closest(CLICKABLE) || el) });
    }
  }
}

function onMove(e) {
  if (!mode.startsWith('pick-')) return;
  const el = e.target;
  if (mode === 'pick-table') {
    const info = findRepeatedContainer(el);
    if (info) {
      const n = rowsOf(info.container, rowSelectorFor(info)).length;
      showBox(info.container, `${info.kind === 'table' ? 'Table' : 'List'} · ${n} rows — click to extract`);
    } else showBox(null);
  } else {
    const labels = { 'pick-text': 'Extract text', 'pick-wait': 'Wait for this', 'pick-click': 'Click this' };
    showBox(el, `${labels[mode] || ''} <${el.tagName.toLowerCase()}>`);
  }
}

function onInput(e) {
  if (mode !== 'record' || !e.isTrusted) return;
  const el = e.target;
  if (!isTextInput(el)) return;
  if (pending && pending.el !== el) flushPending();
  if (!pending) pending = { el, target: buildTarget(el) };
}

function isFileField(el) { return !!el && el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file'; }

function onChange(e) {
  if (mode !== 'record' || !e.isTrusted) return;
  const el = e.target;
  if (isFileField(el)) {
    const names = Array.from(el.files || []).map((f) => f.name);
    if (names.length) emit({ type: 'upload', target: buildTarget(el), value: names.join('; '), sample: names.join('; ') });
    return;
  }
  if (el.tagName === 'SELECT') {
    const opt = el.selectedOptions[0];
    emit({ type: 'select', target: buildTarget(el), value: el.value, label: opt ? clean(opt.text) : undefined });
    return;
  }
  if (pending && pending.el === el) flushPending();
}

function onKey(e) {
  if (mode !== 'record' || !e.isTrusted) return;
  if (['Enter', 'Tab', 'Escape'].includes(e.key)) {
    flushPending();
    if (e.key !== 'Tab') emit({ type: 'press', key: e.key, target: buildTarget(e.target.nodeType === 1 ? e.target : document.body) });
  }
}

function setMode(m) {
  if (mode === 'record' && m !== 'record') flushPending();
  mode = m || 'off';
  if (!mode.startsWith('pick-')) { showBox(null); removeOverlay(); }
}

window.addEventListener('click', onClick, true);
window.addEventListener('mousemove', onMove, true);
window.addEventListener('input', onInput, true);
window.addEventListener('change', onChange, true);
window.addEventListener('keydown', onKey, true);
window.addEventListener('beforeunload', () => flushPending(), true);
ipcRenderer.on('rec:mode', (_e, m) => setMode(m));
ipcRenderer.invoke('rec:get-mode').then(setMode).catch(() => {});

// ---------------------------------------------------------------- 3. runner engine
let snapshotEls = [];

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}

function interactive() {
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=true],summary,[onclick]';
  return Array.from(document.querySelectorAll(sel)).filter((el) => {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > -200 && r.top < innerHeight + 1500;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const commands = {
  async locate({ target, scope }) {
    const el = findElement(target, scope);
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(60);
    return { found: true, ...centerOf(el), tag: el.tagName.toLowerCase(), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
  },
  exists({ target, selector, scope }) {
    if (selector) {
      try { return Array.from(document.querySelectorAll(selector)).some(isVisible); } catch { return false; }
    }
    return !!findElement(target, scope);
  },
  enabledExists({ selector }) {
    try {
      const el = Array.from(document.querySelectorAll(selector)).find(isVisible);
      return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled');
    } catch { return false; }
  },
  textContains({ text }) { return clean(document.body.innerText).toLowerCase().includes(String(text).toLowerCase()); },
  prepareInput({ target, scope }) {
    const el = findElement(target, scope);
    if (!el) return { found: false };
    el.focus();
    if (typeof el.select === 'function') { try { el.select(); } catch {} }
    const val = el.isContentEditable ? el.innerText : el.value;
    return { found: true, hasValue: !!val };
  },
  detectCaptcha() {
    const probes = [
      ['reCAPTCHA', 'iframe[src*="recaptcha"], .g-recaptcha'],
      ['hCaptcha', 'iframe[src*="hcaptcha"], .h-captcha'],
      ['Cloudflare', 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #challenge-form'],
      ['captcha', '[id*="captcha" i], [class*="captcha" i], img[src*="captcha" i], input[name*="captcha" i]'],
    ];
    for (const [kind, sel] of probes) {
      try { if (Array.from(document.querySelectorAll(sel)).some(isVisible)) return { found: true, kind }; } catch {}
    }
    if (/^(just a moment|attention required|verify you are human)/i.test(document.title)) return { found: true, kind: 'Cloudflare' };
    return { found: false };
  },
  markElement({ target, scope, token }) {
    // file fields are often hidden behind a styled "Choose file" button
    const el = findElement(target, scope, { allowHidden: true });
    if (!el) return { found: false };
    el.setAttribute('data-ab-file', token);
    return { found: true, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase() };
  },
  unmarkElement({ token }) {
    const el = document.querySelector(`[data-ab-file="${token}"]`);
    if (el) el.removeAttribute('data-ab-file');
    return true;
  },
  checkState({ target, scope }) {
    const el = findElement(target, scope);
    if (!el) return { found: false };
    const t = toggleControl(el) || { control: el.querySelector && el.querySelector('input[type=checkbox],input[type=radio],[role=checkbox],[role=switch]') };
    if (!t.control) return { found: true, checked: null };
    return { found: true, checked: isChecked(t.control), disabled: !!t.control.disabled, radio: t.control.type === 'radio' || t.control.getAttribute('role') === 'radio' };
  },
  setSelect({ target, scope, value, label }) {
    const el = findElement(target, scope);
    if (!el || el.tagName !== 'SELECT') return { ok: false };
    const opt = Array.from(el.options).find((o) => o.value === value) || Array.from(el.options).find((o) => label && clean(o.text) === label);
    if (!opt) return { ok: false };
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  },
  extractTable({ target, scope }) {
    const container = findElement(target, scope);
    if (!container) return null;
    const rowSelector = target.row_selector || 'tr';
    const kind = container.tagName === 'TABLE' ? 'table' : 'list';
    const { rows, columns } = describeTable(container, kind, rowSelector);
    const cols = target.columns && target.columns.length ? target.columns : columns;
    return rows.map((r) => rowObject(r, cols));
  },
  extractText({ target, scope }) {
    const el = findElement(target, scope);
    return el ? clean(el.innerText || el.value) : null;
  },
  rowCount({ selector }) {
    try { return Array.from(document.querySelectorAll(selector)).filter(isVisible).length; } catch { return 0; }
  },
  rowData({ selector, index }) {
    const rows = Array.from(document.querySelectorAll(selector)).filter(isVisible);
    const row = rows[index];
    if (!row) return null;
    const table = row.closest('table');
    const columns = table ? tableHeaders(table, 'table', cellTexts(row).length) : Array.from({ length: cellTexts(row).length }, (_, i) => `col_${i + 1}`);
    return rowObject(row, columns);
  },
  findLoginFields() {
    const pw = Array.from(document.querySelectorAll('input[type=password]')).find(isVisible);
    const inputs = Array.from(document.querySelectorAll('input')).filter((i) => isVisible(i) && /^(text|email|tel|)$/.test(i.type));
    let user = null;
    if (pw) user = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null;
    if (!user) user = inputs.find((i) => /user|email|login|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.placeholder}`)) || null;
    const form = (pw || user) && (pw || user).closest('form');
    const submit = (form || document).querySelector('button[type=submit],input[type=submit]') ||
      Array.from((form || document).querySelectorAll('button,[role=button]')).find((b) => isVisible(b) && /log ?in|sign ?in|continue|next|submit/i.test(b.innerText));
    const otp = Array.from(document.querySelectorAll('input')).find((i) => isVisible(i) && /one-time-code|otp|totp|2fa|mfa|code/i.test(`${i.autocomplete} ${i.name} ${i.id}`));
    return {
      username: user ? buildTarget(user) : null,
      password: pw ? buildTarget(pw) : null,
      submit: submit ? buildTarget(submit) : null,
      totp: otp ? buildTarget(otp) : null,
    };
  },
  snapshot({ privateMode = false } = {}) {
    snapshotEls = interactive().slice(0, 400);
    const txt = (el, n) => (privateMode && !isUiText(el) ? maskText(el.innerText, n) : short(el.innerText, n)) || undefined;
    return {
      url: privateMode ? maskUrl(location.href) : location.href,
      title: privateMode ? maskText(document.title, 60) : document.title,
      elements: snapshotEls.map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        text: txt(el, 100),
        role: el.getAttribute('role') || undefined,
        label: labelOf(el) || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        href: el.tagName === 'A' ? (privateMode ? maskUrl(el.getAttribute('href')) : short(el.getAttribute('href'), 120)) : undefined,
        type: el.getAttribute('type') || undefined,
        value: el.type === 'password' ? undefined : ((privateMode ? maskText(el.value) : short(el.value, 60)) || undefined),
      })),
      // private mode: the page's code outline instead of its visible text
      text_excerpt: privateMode ? pageOutline({ privateMode: true, maxLines: 250 }) : short(document.body ? document.body.innerText : '', 6000),
    };
  },
  outline({ privateMode = true } = {}) { return pageOutline({ privateMode }); },
  async rectOfIndex({ index }) {
    const el = snapshotEls[index];
    if (!el || !el.isConnected) return { found: false };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(60);
    return { found: true, ...centerOf(el), tag: el.tagName.toLowerCase() };
  },
  targetOfIndex({ index }) {
    const el = snapshotEls[index];
    return el && el.isConnected ? buildTarget(el) : null;
  },
  focusIndex({ index }) {
    const el = snapshotEls[index];
    if (!el) return false;
    el.focus(); if (typeof el.select === 'function') { try { el.select(); } catch {} }
    return true;
  },
  iframeOffset({ name, url }) {
    const frames = Array.from(document.querySelectorAll('iframe,frame'));
    const f = frames.find((x) => name && x.name === name) || frames.find((x) => url && x.src && (x.src === url || url.startsWith(x.src)));
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const st = getComputedStyle(f);
    return { x: r.x + parseFloat(st.borderLeftWidth || 0), y: r.y + parseFloat(st.borderTopWidth || 0) };
  },
  scrollInfo() { return { y: scrollY, max: document.documentElement.scrollHeight - innerHeight }; },
  viewport() { return { w: innerWidth, h: innerHeight }; },
};

ipcRenderer.on('run:cmd', async (_e, { reqId, cmd, args }) => {
  let result = null, error = null;
  try {
    if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
    result = await commands[cmd](args || {});
  } catch (err) { error = String(err && err.message || err); }
  ipcRenderer.send('run:reply', reqId, result, error);
});
