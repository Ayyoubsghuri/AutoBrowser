// Templates used in step values: {{row.Name}}, {{account.username}}, {{today}} …
// with optional formatting filters:
//   {{row.Date | date:DD/MM/YYYY}}   {{row.Name | upper}}   {{row.Phone | digits}}
//   {{row.Amount | number:2}}        {{row.City | default:"Rabat"}}
// Plain CommonJS with no Electron imports, so it is unit-testable with node.

// Looks up "row.Case ID" or "row.extra.City"; keys may contain spaces or dots.
function lookup(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  let i = 0;
  while (i < parts.length) {
    if (cur == null || typeof cur !== 'object') return undefined;
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const k = parts.slice(i, j).join('.');
      if (Object.prototype.hasOwnProperty.call(cur, k)) { cur = cur[k]; i = j; found = true; break; }
    }
    if (!found) return undefined;
  }
  return cur;
}

// ------------------------------------------------------------------ dates
const pad = (n, w = 2) => String(n).padStart(w, '0');

function parseDate(v, inFormat) {
  if (v instanceof Date) return v;
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase() === 'now' || s.toLowerCase() === 'today') return new Date();
  if (inFormat) {
    const order = inFormat.match(/YYYY|YY|MM|M|DD|D|HH|mm|ss/g) || [];
    const nums = s.match(/\d+/g) || [];
    const got = {};
    order.forEach((tok, i) => { got[tok] = Number(nums[i]); });
    const y = got.YYYY ?? (got.YY != null ? 2000 + got.YY : NaN);
    const d = new Date(y, (got.MM ?? got.M) - 1, got.DD ?? got.D, got.HH || 0, got.mm || 0, got.ss || 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Excel serial day number (e.g. 45413)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let [a, b] = [+m[1], +m[2]];
    // day first (01/05/2024 = 1 May) unless that is impossible
    let day = a; let month = b;
    if (b > 12 && a <= 12) { day = b; month = a; }
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(year, month - 1, day, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(d, fmt) {
  const map = {
    YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
    DD: pad(d.getDate()), D: d.getDate(), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()),
  };
  return fmt.replace(/YYYY|YY|MM|M|DD|D|HH|mm|ss/g, (t) => String(map[t]));
}

// ------------------------------------------------------------------ filters
function toNumber(s) {
  let t = String(s ?? '').replace(/[^\d,.-]/g, '');
  if (t.includes(',') && t.includes('.')) {
    // the last separator is the decimal one: 1.250,50 or 1,250.50
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  const n = Number(t);
  return t === '' || Number.isNaN(n) ? null : n;
}

const FILTERS = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  title: (v) => String(v).toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
  trim: (v) => String(v).trim(),
  digits: (v) => String(v).replace(/\D/g, ''),
  nospace: (v) => String(v).replace(/\s+/g, ''),
  first: (v) => String(v).trim().split(/\s+/)[0] || '',
  last: (v) => { const p = String(v).trim().split(/\s+/); return p[p.length - 1] || ''; },
  slice: (v, a = '0', b) => String(v).slice(Number(a), b === undefined ? undefined : Number(b)),
  replace: (v, from = '', to = '') => String(v).split(from).join(to),
  split: (v, sep = ' ', i = '0') => String(v).split(sep)[Number(i)] ?? '',
  pad: (v, n = '2', ch = '0') => String(v).padStart(Number(n), ch),
  prefix: (v, p = '') => (String(v) ? p + v : ''),
  suffix: (v, p = '') => (String(v) ? v + p : ''),
  default: (v, d = '') => (String(v ?? '').trim() === '' ? d : v),
  number: (v, decimals, dec = '.') => {
    const n = toNumber(v);
    if (n === null) return String(v);
    const s = decimals === undefined ? String(n) : n.toFixed(Number(decimals));
    return dec === '.' ? s : s.replace('.', dec);
  },
  date: (v, fmt = 'YYYY-MM-DD') => {
    const d = parseDate(v);
    return d ? formatDate(d, fmt) : String(v ?? '');
  },
  // read an unusual input order first: {{row.D | parsedate:MM/DD/YYYY | date:DD.MM.YYYY}}
  parsedate: (v, inFmt = 'DD/MM/YYYY') => {
    const d = parseDate(v, inFmt);
    return d ? formatDate(d, 'YYYY-MM-DD HH:mm:ss').replace(/ 00:00:00$/, '') : String(v ?? '');
  },
  yesno: (v, yes = 'yes', no = 'no') => (/^(1|true|yes|y|x|✓|✔|on|checked|oui|si|sí|ja|نعم|vrai)$/i.test(String(v).trim()) ? yes : no),
};

// split "a | b:'x|y' | c" on pipes outside quotes
function splitPipes(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function parseFilter(spec) {
  const parts = []; let cur = ''; let q = null;
  for (const ch of spec) {
    if (q) { if (ch === q) { q = null; continue; } cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ':' && parts.length === 0) { parts.push(cur); cur = ''; continue; }
    if (ch === ':' && parts.length > 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return { name: parts[0].trim().toLowerCase(), args: parts.slice(1) };
}

/** Evaluates one {{ … }} expression. Throws on an unknown filter. */
function evaluate(expr, vars) {
  const [head, ...filters] = splitPipes(expr);
  let v;
  if (/^(["']).*\1$/.test(head)) v = head.slice(1, -1); // literal: {{"2024-01-05" | date:DD/MM/YYYY}}
  else v = lookup(vars, head);
  if (v == null) v = '';
  if (typeof v === 'object') v = JSON.stringify(v);
  for (const f of filters) {
    if (!f) continue;
    const parsed = parseFilter(f);
    const { name } = parsed;
    // date formats may contain ':' (HH:mm), so everything after the name is the format
    const args = name === 'date' || name === 'parsedate' ? [parsed.args.join(':')].filter((a) => a !== '') : parsed.args;
    const fn = FILTERS[name];
    if (!fn) throw new Error(`unknown format "${name}"`);
    v = fn(v, ...args);
  }
  return String(v);
}

/**
 * Renders all {{ … }} in a string. A bare {{row}} is kept (it is the row-scope marker
 * used inside list loops).
 */
function render(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, expr) => {
    if (expr === 'row' && (vars.row == null || typeof vars.row === 'object')) return m;
    return evaluate(expr, vars);
  });
}

/** Like render but never throws: errors are returned for the UI preview. */
function preview(str, vars) {
  try { return { text: render(str, vars) }; } catch (e) { return { error: e.message }; }
}

module.exports = { render, preview, lookup, parseDate, formatDate, FILTERS };
