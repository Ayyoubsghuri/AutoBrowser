// Replays flows inside real browser tabs.
//
// Run modes:
//   exact    - replay recorded steps literally. No AI, no API key, free.
//   assist   - recorded steps, but steps that carry a tip are handed to the AI
//              agent, and selectors that broke are re-found by the AI.
//   compiled - run the AI-built version of the flow (loops, login, variables).
const { ipcMain } = require('electron');
const { Human, sleep } = require('./human');

let reqCounter = 0;
const pendingReplies = new Map();
ipcMain.on('run:reply', (_e, reqId, result, error) => {
  const p = pendingReplies.get(reqId);
  if (!p) return;
  pendingReplies.delete(reqId);
  clearTimeout(p.timer);
  if (error) p.reject(new Error(error)); else p.resolve(result);
});

function frameCall(frame, cmd, args = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const reqId = `${Date.now()}-${++reqCounter}`;
    const timer = setTimeout(() => { pendingReplies.delete(reqId); reject(new Error(`page did not answer "${cmd}"`)); }, timeout);
    pendingReplies.set(reqId, { resolve, reject, timer });
    try { frame.send('run:cmd', { reqId, cmd, args }); } catch (e) { clearTimeout(timer); pendingReplies.delete(reqId); reject(e); }
  });
}

class StopError extends Error {}

const { render, lookup } = require('./template');

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'x', '✓', '✔', 'on', 'checked', 'oui', 'si', 'sí', 'ja', 'نعم', 'vrai']);
const truthy = (v) => TRUTHY.has(String(v ?? '').trim().toLowerCase());

function flattenRow(row, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenRow(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

function rowCondition(row, cond) {
  const s = String(lookup(row || {}, cond.row) ?? '').trim();
  const want = String(cond.value ?? '').trim().toLowerCase();
  switch (cond.op || 'not_empty') {
    case 'empty': return s === '';
    case 'not_empty': return s !== '';
    case 'equals': return s.toLowerCase() === want;
    case 'not_equals': return s.toLowerCase() !== want;
    case 'contains': return s.toLowerCase().includes(want);
    case 'truthy': return truthy(s);
    case 'falsy': return !truthy(s);
    default: return true;
  }
}

function builtinVars() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    now: d.toISOString(),
    timestamp: String(Date.now()),
  };
}

class Runner {
  /**
   * @param {object} deps
   * @param {(profileId:string)=>Promise<{id:number, view:Electron.WebContentsView}>} deps.tabForProfile
   * @param {(method:string, path:string, body?:any)=>Promise<any>} deps.api
   * @param {(channel:string, payload:any)=>void} deps.emit
   * @param {()=>number} deps.speed
   */
  constructor(deps) {
    this.deps = deps;
    this.human = new Human(deps.speed);
    this.active = new Map(); // runId -> {stopped}
  }

  stop(runId) {
    for (const [id, st] of this.active) if (!runId || id === runId) st.stopped = true;
  }

  async runMany({ flow, profileIds, mode = 'exact', parallel = false }) {
    const ids = profileIds && profileIds.length ? profileIds : [null];
    const jobs = ids.map((pid) => () => this.runOne({ flow, profileId: pid, mode }));
    if (parallel) return Promise.all(jobs.map((j) => j()));
    const out = [];
    for (const j of jobs) out.push(await j());
    return out;
  }

  async runOne({ flow, profileId, mode }) {
    const run = await this.deps.api('POST', '/runs', { flow_id: flow.id, profile_id: profileId, mode: mode === 'exact' ? 'replay' : 'ai' });
    const state = { stopped: false };
    this.active.set(run.id, state);
    const { emit } = this.deps;
    const logBuf = [];
    const outBuf = [];
    const flush = async (extra = {}) => {
      const body = { log: logBuf.splice(0), output: outBuf.splice(0), ...extra };
      if (body.log.length || body.output.length || extra.status) {
        await this.deps.api('PATCH', `/runs/${run.id}`, body).catch(() => {});
      }
    };
    const log = (level, msg, stepId) => {
      const entry = { t: Date.now(), level, msg, step: stepId };
      logBuf.push(entry);
      emit('run:log', { runId: run.id, flowId: flow.id, profileId, ...entry });
    };
    const flushTimer = setInterval(() => flush(), 1500);

    emit('run:status', { runId: run.id, flowId: flow.id, profileId, status: 'running' });
    let status = 'success';
    try {
      const tab = await this.deps.tabForProfile(profileId);
      const wc = tab.view.webContents;
      const steps = mode === 'compiled' ? (flow.compiled && flow.compiled.steps) || [] : flow.steps || [];
      if (mode === 'compiled' && !steps.length) throw new Error('This flow has no AI-built version yet. Click "Build with AI" first.');
      let account = {};
      if (profileId) {
        let site = flow.start_url || '';
        try { site = new URL(flow.start_url).hostname; } catch {}
        account = await this.deps.api('GET', `/profiles/${profileId}/secrets?site=${encodeURIComponent(site)}`).catch(() => ({}));
      }
      const ctx = {
        wc, tab, mode, state, log, flowId: flow.id, profileId,
        vars: { ...builtinVars(), account, vars: {} },
        output: (name, data) => {
          outBuf.push({ name, data, url: wc.getURL(), profile_id: profileId, t: Date.now() });
          emit('run:output', { runId: run.id, name, data });
        },
      };
      log('info', `Starting "${flow.name}" (${mode})${profileId ? ` as ${account.username || profileId}` : ''}`);
      const first = steps[0];
      if (flow.start_url && !(first && first.type === 'goto')) {
        await this.goto(ctx, flow.start_url);
      }
      if (flow.data && flow.data.dataset_id) await this.runRows(ctx, flow, steps, run.id);
      else await this.execSteps(ctx, steps);
      log('info', 'Finished ✓');
    } catch (e) {
      status = e instanceof StopError ? 'stopped' : 'failed';
      log('error', e.message || String(e));
    } finally {
      clearInterval(flushTimer);
      this.active.delete(run.id);
      await flush({ status, finished: true });
      emit('run:status', { runId: run.id, flowId: flow.id, profileId, status });
    }
    return { runId: run.id, status };
  }

  checkStop(ctx) { if (ctx.state.stopped) throw new StopError('Stopped by user'); }

  // Data-driven run: steps before `start_step_id` run once (login…), the rest once per row.
  async runRows(ctx, flow, steps, runId) {
    const cfg = flow.data;
    const { rows, total } = await this.deps.api('GET', `/flows/${flow.id}/data-rows`);
    let start = cfg.start_step_id ? steps.findIndex((s) => s.id === cfg.start_step_id) : 0;
    if (start < 0) { ctx.log('warn', 'The "repeat from here" step was not found; repeating the whole flow for each row'); start = 0; }
    const once = steps.slice(0, start);
    const each = steps.slice(start);
    ctx.log('info', `Data: ${rows.length} row${rows.length === 1 ? '' : 's'} to process${total !== rows.length ? ` (of ${total} matching)` : ''}`);
    if (once.length) await this.execSteps(ctx, once);
    let ok = 0;
    let failed = 0;
    const progress = (done) => this.deps.emit('run:progress', { runId, flowId: flow.id, profileId: ctx.profileId, done, total: rows.length, ok, failed });
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const num = row._row ?? i + 1;
      progress(i);
      ctx.vars.row = row;
      ctx.vars.index = i;
      ctx.vars.vars = {}; // fresh lists for every data row
      ctx.rowResult = {};
      let status = 'success';
      let message = '';
      ctx.log('info', `Row ${num} (${i + 1}/${rows.length})`);
      try {
        this.checkStop(ctx);
        await this.execSteps(ctx, each);
        ok++;
      } catch (e) {
        status = e instanceof StopError ? 'stopped' : 'failed';
        message = e.message || String(e);
        if (status === 'failed') { failed++; ctx.log('error', `Row ${num} failed: ${message}`); }
        if (e instanceof StopError || cfg.stop_on_error) {
          ctx.output('_rows', [{ ...flattenRow(row), _row: num, _status: status, _message: message, ...ctx.rowResult }]);
          ctx.rowResult = null;
          progress(i + 1);
          if (e instanceof StopError) throw e;
          throw new Error(`Stopped at row ${num} (stop on first error is on)`);
        }
      }
      ctx.output('_rows', [{ ...flattenRow(row), _row: num, _status: status, _message: message, ...ctx.rowResult }]);
      ctx.rowResult = null;
    }
    progress(rows.length);
    ctx.log(failed ? 'warn' : 'info', `Rows done: ${ok} succeeded, ${failed} failed`);
    if (failed && !ok) throw new Error('Every row failed');
  }

  async execSteps(ctx, steps) {
    for (const step of steps) {
      this.checkStop(ctx);
      try {
        await this.exec(ctx, step);
      } catch (e) {
        if (e instanceof StopError) throw e;
        if (step.optional) { ctx.log('warn', `Skipped optional step: ${e.message}`, step.id); continue; }
        throw new Error(`Step ${step.id} (${step.type}) failed: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------- frames
  frameFor(ctx, step) {
    const main = ctx.wc.mainFrame;
    const want = step.target && step.target.frame;
    if (!want) return main;
    const frames = main.framesInSubtree;
    const exact = frames.find((f) => f.url === want);
    if (exact) return exact;
    try {
      const w = new URL(want);
      return frames.find((f) => { try { const u = new URL(f.url); return u.origin === w.origin && u.pathname === w.pathname; } catch { return false; } }) || main;
    } catch { return main; }
  }

  async frameOffset(frame) {
    let x = 0, y = 0;
    for (let f = frame; f && f.parent; f = f.parent) {
      const off = await frameCall(f.parent, 'iframeOffset', { name: f.name, url: f.url }).catch(() => null);
      if (off) { x += off.x; y += off.y; }
    }
    return { x, y };
  }

  // ------------------------------------------------------------- element helpers
  async locate(ctx, step, { timeout = 10000 } = {}) {
    const frame = this.frameFor(ctx, step);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this.checkStop(ctx);
      const r = await frameCall(frame, 'locate', { target: step.target, scope: ctx.scope }).catch(() => null);
      if (r && r.found) {
        const off = await this.frameOffset(frame);
        return { ...r, x: r.x + off.x, y: r.y + off.y, frame };
      }
      await sleep(300);
    }
    // Self-heal with AI (assist / compiled modes only).
    if (ctx.mode !== 'exact') {
      const healed = await this.aiLocate(ctx, step).catch((e) => { ctx.log('warn', `AI could not re-find element: ${e.message}`, step.id); return null; });
      if (healed) return healed;
    }
    return null;
  }

  async aiLocate(ctx, step) {
    const frame = ctx.wc.mainFrame;
    const snap = await this.snapshot(ctx, false);
    const desc = step.tip || step.target?.label || step.target?.text || `${step.type} target`;
    const res = await this.deps.api('POST', '/ai/locate', { description: desc, recorded: step.target, snapshot: snap });
    if (!res || res.index < 0 || res.confidence < 0.4) return null;
    const r = await frameCall(frame, 'rectOfIndex', { index: res.index });
    if (!r || !r.found) return null;
    ctx.log('info', `AI re-found the element (${Math.round(res.confidence * 100)}%): ${res.reason}`, step.id);
    return { ...r, frame };
  }

  async snapshot(ctx, withScreenshot = true) {
    // Private mode: the AI gets the page's code outline with every value masked, and no screenshot.
    const privateMode = !!(this.deps.privacy && this.deps.privacy());
    const snap = await frameCall(ctx.wc.mainFrame, 'snapshot', { privateMode });
    if (withScreenshot && !privateMode) {
      try {
        const img = await ctx.wc.capturePage();
        const size = img.getSize();
        const scaled = size.width > 1280 ? img.resize({ width: 1280 }) : img;
        snap.screenshot_b64 = scaled.toJPEG(70).toString('base64');
      } catch {}
    }
    return snap;
  }

  async settle(ctx, minMs = 250) {
    await this.human.wait(minMs, minMs * 2);
    if (ctx.wc.isLoading()) {
      await Promise.race([
        new Promise((r) => ctx.wc.once('did-stop-loading', r)),
        sleep(30000),
      ]);
      await this.human.wait(200, 500);
    }
  }

  async clickBox(ctx, box) {
    let navStarted = false;
    const onNav = () => { navStarted = true; };
    ctx.wc.once('did-start-navigation', onNav);
    await this.human.click(ctx.wc, box);
    await sleep(350);
    ctx.wc.removeListener('did-start-navigation', onNav);
    await this.settle(ctx, navStarted ? 400 : 150);
  }

  async fill(ctx, step, text) {
    const box = await this.locate(ctx, step);
    if (!box) throw new Error('input not found');
    await this.human.click(ctx.wc, box);
    await this.human.wait(80, 200);
    const prep = await frameCall(box.frame, 'prepareInput', { target: step.target, scope: ctx.scope }).catch(() => ({}));
    if (prep && prep.hasValue) await this.human.selectAllAndDelete(ctx.wc);
    await this.human.type(ctx.wc, text);
  }

  async goto(ctx, url) {
    ctx.log('info', `Open ${url}`);
    await ctx.wc.loadURL(url).catch((e) => { if (!String(e.message).includes('ERR_ABORTED')) throw e; });
    await this.settle(ctx, 500);
  }

  async conditionTrue(ctx, cond) {
    if (!cond) return true;
    if (cond.row) return rowCondition(ctx.vars.row, cond);
    const frame = ctx.wc.mainFrame;
    if (cond.exists) {
      const has = await frameCall(frame, 'exists', typeof cond.exists === 'string' ? { selector: render(cond.exists, ctx.vars) } : { target: cond.exists, scope: ctx.scope });
      return cond.not ? !has : has;
    }
    if (cond.missing) return !(await frameCall(frame, 'exists', { selector: cond.missing }));
    if (cond.text_contains) return frameCall(frame, 'textContains', { text: render(cond.text_contains, ctx.vars) });
    if (cond.url_contains) return ctx.wc.getURL().includes(cond.url_contains);
    return true;
  }

  // ------------------------------------------------------------- step executor
  async exec(ctx, step) {
    const v = (s) => render(s, ctx.vars);
    const label = step.tip ? ` — ${step.tip}` : '';

    // In assist mode, a recorded step with a tip is executed by the AI agent.
    if (ctx.mode === 'assist' && step.tip && step.type !== 'ai' && step.type !== 'goto') {
      const what = step.target ? ` (recorded: ${step.type} on "${step.target.text || step.target.label || step.target.tag}")` : '';
      return this.aiStep(ctx, { ...step, type: 'ai', instruction: `${step.tip}${what}` });
    }

    if (step.type !== 'if' && step.condition && !(await this.conditionTrue(ctx, step.condition))) {
      ctx.log('info', `Skip ${step.type} (condition not met)`, step.id);
      return;
    }

    switch (step.type) {
      case 'goto':
        return this.goto(ctx, v(step.url || step.value));

      case 'click': {
        const box = await this.locate(ctx, step);
        if (!box) throw new Error(`element not found: ${step.target?.text || step.target?.selectors?.[0]?.value || ''}`);
        ctx.log('info', `Click ${step.target?.text ? `"${step.target.text}"` : `<${box.tag}>`}${label}`, step.id);
        return this.clickBox(ctx, box);
      }

      case 'type': {
        const text = v(step.value ?? '');
        ctx.log('info', `Type into ${step.target?.label || step.target?.tag || 'field'}: ${step.secret ? '••••••' : text}`, step.id);
        return this.fill(ctx, step, text);
      }

      case 'select': {
        const box = await this.locate(ctx, step);
        if (!box) throw new Error('select not found');
        ctx.log('info', `Select "${step.label || step.value}"`, step.id);
        const r = await frameCall(box.frame, 'setSelect', { target: step.target, scope: ctx.scope, value: v(step.value), label: step.label });
        if (!r || !r.ok) throw new Error('option not found');
        return this.settle(ctx, 150);
      }

      case 'check': {
        const want = truthy(v(step.value ?? 'true'));
        const box = await this.locate(ctx, step);
        if (!box) throw new Error(`checkbox not found: ${step.target?.label || step.target?.selectors?.[0]?.value || ''}`);
        const before = await frameCall(box.frame, 'checkState', { target: step.target, scope: ctx.scope });
        const name = step.target?.label || step.target?.text || 'checkbox';
        if (before && before.checked === want) { ctx.log('info', `${name} already ${want ? 'on' : 'off'}`, step.id); return; }
        if (before && before.radio && !want) { ctx.log('info', `${name}: radio left as is`, step.id); return; }
        ctx.log('info', `${want ? 'Tick' : 'Untick'} ${name}`, step.id);
        await this.clickBox(ctx, box);
        const after = await frameCall(box.frame, 'checkState', { target: step.target, scope: ctx.scope }).catch(() => null);
        if (after && after.found && after.checked !== null && after.checked !== want) throw new Error(`${name} did not change`);
        return;
      }

      case 'press':
        ctx.log('info', `Press ${step.key}`, step.id);
        await this.human.key(ctx.wc, step.key || 'Enter');
        return this.settle(ctx, 300);

      case 'scroll':
        await this.human.scroll(ctx.wc, Number(step.value) || 600);
        return this.human.wait(200, 500);

      case 'wait': {
        if (step.target) {
          const box = await this.locate(ctx, step, { timeout: step.ms || 20000 });
          if (!box) throw new Error('timed out waiting for element');
          return;
        }
        return sleep(step.ms || 1000);
      }

      case 'extract_table': {
        const frame = this.frameFor(ctx, step);
        let rows = null;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !(rows && rows.length)) {
          rows = await frameCall(frame, 'extractTable', { target: step.target, scope: ctx.scope }).catch(() => null);
          if (!rows || !rows.length) await sleep(400);
        }
        if (!rows) throw new Error('table not found');
        ctx.log('info', `Extracted ${rows.length} rows → ${step.name || 'table'}`, step.id);
        ctx.output(step.name || 'table', rows);
        const key = step.name || 'table';
        ctx.vars.vars[key] = (ctx.vars.vars[key] || []).concat(rows); // keeps growing across pages of a pagination loop
        return;
      }

      case 'extract_text': {
        const box = await this.locate(ctx, step, { timeout: 8000 });
        if (!box) throw new Error('element not found');
        const text = await frameCall(box.frame, 'extractText', { target: step.target, scope: ctx.scope });
        ctx.log('info', `Extracted ${step.name || 'text'}: ${String(text).slice(0, 80)}`, step.id);
        if (ctx.itemResult) ctx.itemResult[step.name || 'text'] = text; // per-item result column
        else if (ctx.rowResult) ctx.rowResult[step.name || 'text'] = text; // per-row result column
        else ctx.output(step.name || 'text', ctx.scope ? { ...(ctx.vars.row || {}), [step.name || 'text']: text } : text);
        ctx.vars.vars[step.name || 'text'] = text;
        return;
      }

      case 'login':
        return this.login(ctx, step);

      case 'if':
        if (await this.conditionTrue(ctx, step.condition)) return this.execSteps(ctx, step.steps || []);
        ctx.log('info', 'Condition false, skipping block', step.id);
        return;

      case 'loop':
        return this.loop(ctx, step);

      case 'ai':
        return this.aiStep(ctx, step);

      default:
        throw new Error(`unknown step type ${step.type}`);
    }
  }

  async login(ctx, step) {
    const acc = ctx.vars.account || {};
    if (!acc.username && !acc.password) throw new Error('No saved login for this account/site. Add one under Accounts.');
    const frame = ctx.wc.mainFrame;
    let map = {};
    if (step.value) { try { map = JSON.parse(step.value); } catch {} }
    const toTarget = (sel) => (sel ? (Array.isArray(sel) ? { selectors: sel } : sel.selectors ? sel : { selectors: [{ kind: 'css', value: String(sel) }] }) : null);
    let fields = { username: toTarget(map.username), password: toTarget(map.password), submit: toTarget(map.submit), totp: toTarget(map.totp) };
    if (!fields.username && !fields.password) {
      fields = await frameCall(frame, 'findLoginFields');
      if (!fields.username && !fields.password) { ctx.log('info', 'No login form found — assuming already logged in', step.id); return; }
    }
    ctx.log('info', `Logging in as ${acc.username}`, step.id);
    if (fields.username) await this.fill(ctx, { target: fields.username }, acc.username || '');
    if (fields.password) {
      const pwBox = await this.locate(ctx, { target: fields.password }, { timeout: 8000 });
      if (!pwBox && fields.submit) { // two-step logins: username -> next -> password
        const b = await this.locate(ctx, { target: fields.submit }, { timeout: 3000 });
        if (b) await this.clickBox(ctx, b);
      }
      await this.fill(ctx, { target: fields.password }, acc.password || '');
    }
    const submit = fields.submit && (await this.locate(ctx, { target: fields.submit }, { timeout: 3000 }));
    if (submit) await this.clickBox(ctx, submit); else { await this.human.key(ctx.wc, 'Enter'); await this.settle(ctx, 600); }
    if (acc.totp) {
      await sleep(1200);
      let otp = fields.totp;
      if (!otp) { const f2 = await frameCall(frame, 'findLoginFields').catch(() => ({})); otp = f2.totp; }
      if (otp) {
        const fresh = await this.deps.api('GET', `/profiles/${ctx.profileId}/secrets`).catch(() => acc);
        ctx.log('info', 'Entering 2FA code', step.id);
        await this.fill(ctx, { target: otp }, fresh.totp || acc.totp);
        await this.human.key(ctx.wc, 'Enter');
        await this.settle(ctx, 800);
      }
    }
  }

  async loop(ctx, step) {
    const cfg = step.loop || {};
    const max = cfg.max || 100;
    const children = step.steps || [];
    const frame = ctx.wc.mainFrame;
    if (cfg.over === 'rows') {
      const selector = render(cfg.selector, ctx.vars);
      const n = Math.min(await frameCall(frame, 'rowCount', { selector }), max);
      ctx.log('info', `Loop over ${n} rows`, step.id);
      const outerScope = ctx.scope, outerRow = ctx.vars.row;
      for (let i = 0; i < n; i++) {
        this.checkStop(ctx);
        ctx.scope = { selector, index: i };
        ctx.vars.row = (await frameCall(frame, 'rowData', { selector, index: i })) || {};
        ctx.vars.index = i;
        await this.execSteps(ctx, children);
      }
      ctx.scope = outerScope; ctx.vars.row = outerRow;
      return;
    }
    if (cfg.over === 'until_missing') {
      // Run the body, then click `selector` (e.g. "Next page") until it is gone/disabled.
      for (let i = 0; i < max; i++) {
        this.checkStop(ctx);
        ctx.vars.index = i;
        await this.execSteps(ctx, children);
        const sel = render(cfg.selector, ctx.vars);
        const more = await frameCall(frame, 'enabledExists', { selector: sel });
        if (!more) { ctx.log('info', `Loop finished after ${i + 1} pages`, step.id); return; }
        const box = await this.locate(ctx, { target: { selectors: [{ kind: 'css', value: sel }] } }, { timeout: 3000 });
        if (!box) return;
        ctx.log('info', `Next page (${i + 2})`, step.id);
        await this.clickBox(ctx, box);
      }
      return;
    }
    if (cfg.over === 'items') return this.loopItems(ctx, step);
    if (cfg.over === 'list' && Array.isArray(cfg.items)) {
      for (const item of cfg.items.slice(0, max)) { ctx.vars.item = item; await this.execSteps(ctx, children); }
      return;
    }
    const times = Math.min(cfg.count || 1, max);
    for (let i = 0; i < times; i++) { ctx.vars.index = i; await this.execSteps(ctx, children); }
  }

  // "For each item": open every item of a list (by its link, or by clicking its row on the
  // list page) and run the child steps there. Values extracted on each item page are
  // merged with that item's list data into one result table.
  async loopItems(ctx, step) {
    const cfg = step.loop || {};
    const children = step.steps || [];
    const frame = () => ctx.wc.mainFrame;
    let items = cfg.from ? ctx.vars.vars[cfg.from] : null;
    let mode = cfg.open || 'link';
    if (mode === 'link' && !(Array.isArray(items) && items.some((it) => it && it._link))) mode = 'click';
    let count = Array.isArray(items) ? items.length : 0;
    if (mode === 'click') {
      if (!cfg.list_url || !cfg.row_selector) throw new Error('This loop does not know the list page; record it again');
      await this.goto(ctx, cfg.list_url);
      count = await frameCall(frame(), 'rowCount', { selector: cfg.row_selector });
    }
    count = Math.min(count, cfg.max || 500);
    if (!count) throw new Error(cfg.from ? `No items in "${cfg.from}": the list was empty or not extracted` : 'The list is empty');
    const outName = step.name || `${cfg.from || 'items'}_details`;
    const clickTarget = cfg.click_target || { selectors: [{ kind: 'css', value: '{{row}} a[href]' }, { kind: 'css', value: '{{row}}' }] };
    ctx.log('info', `For each of ${count} items (${mode === 'link' ? 'opening each link' : 'clicking each row'})`, step.id);
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < count; i++) {
      this.checkStop(ctx);
      let item = Array.isArray(items) ? items[i] || {} : null;
      const outerItem = ctx.vars.item;
      ctx.itemResult = {};
      let status = 'success';
      let message = '';
      try {
        if (mode === 'link') {
          await this.goto(ctx, item._link);
        } else {
          if (i > 0 || ctx.wc.getURL() !== cfg.list_url) await this.goto(ctx, cfg.list_url);
          if (!item) item = (await frameCall(frame(), 'rowData', { selector: cfg.row_selector, index: i })) || {};
          const outerScope = ctx.scope;
          ctx.scope = { selector: cfg.row_selector, index: i };
          const box = await this.locate(ctx, { target: clickTarget }, { timeout: 8000 });
          ctx.scope = outerScope;
          if (!box) throw new Error(`could not open item ${i + 1}`);
          await this.clickBox(ctx, box);
        }
        ctx.vars.item = item;
        ctx.vars.index = i;
        ctx.log('info', `Item ${i + 1}/${count}`, step.id);
        await this.execSteps(ctx, children);
        ok++;
      } catch (e) {
        status = e instanceof StopError ? 'stopped' : 'failed';
        message = e.message || String(e);
        if (status === 'failed') { failed++; ctx.log('warn', `Item ${i + 1} failed: ${message}`, step.id); }
        if (e instanceof StopError) {
          ctx.output(outName, [{ ...flattenRow(item || {}), ...ctx.itemResult, _status: status, _message: message }]);
          ctx.itemResult = null;
          throw e;
        }
      }
      ctx.output(outName, [{ _item: i + 1, ...flattenRow(item || {}), ...ctx.itemResult, _status: status, _message: message }]);
      ctx.itemResult = null;
      ctx.vars.item = outerItem;
    }
    ctx.log(failed ? 'warn' : 'info', `Items done: ${ok} succeeded, ${failed} failed → "${outName}"`, step.id);
    if (failed && !ok) throw new Error('Every item failed');
  }

  async aiStep(ctx, step) {
    const privateMode = !!(this.deps.privacy && this.deps.privacy());
    // private mode: keep {{row.x}} placeholders in the instruction; real values are filled in locally when typing
    const instruction = privateMode ? (step.instruction || step.tip || '') : render(step.instruction || step.tip || '', ctx.vars);
    ctx.log('info', `AI: ${instruction}`, step.id);
    const history = [];
    const frame = ctx.wc.mainFrame;
    for (let i = 0; i < (step.max_actions || 15); i++) {
      this.checkStop(ctx);
      const snap = await this.snapshot(ctx, true);
      const safeVars = { ...ctx.vars, account: { username: ctx.vars.account?.username } };
      const act = await this.deps.api('POST', '/ai/act', { instruction, snapshot: snap, history, variables: safeVars });
      ctx.log('info', `  → ${act.action}${act.index >= 0 ? ` [${act.index}]` : ''}${act.value && act.action !== 'extract' ? ` "${act.value}"` : ''} · ${act.reason}`, step.id);
      const el = snap.elements[act.index];
      const desc = el ? `${el.tag} "${el.text || el.label || el.placeholder || ''}"` : '';
      switch (act.action) {
        case 'done': return;
        case 'fail': throw new Error(`AI could not complete: ${act.reason}`);
        case 'click': {
          const r = await frameCall(frame, 'rectOfIndex', { index: act.index });
          if (!r || !r.found) { history.push(`click [${act.index}] failed: element gone`); break; }
          await this.clickBox(ctx, r);
          break;
        }
        case 'type': {
          const r = await frameCall(frame, 'rectOfIndex', { index: act.index });
          if (!r || !r.found) { history.push(`type [${act.index}] failed`); break; }
          await this.human.click(ctx.wc, r);
          await frameCall(frame, 'focusIndex', { index: act.index });
          await this.human.selectAllAndDelete(ctx.wc);
          // let the AI reference saved secrets without ever seeing them
          await this.human.type(ctx.wc, render(act.value, ctx.vars));
          break;
        }
        case 'select': {
          const t = await frameCall(frame, 'targetOfIndex', { index: act.index });
          if (t) await frameCall(frame, 'setSelect', { target: t, value: act.value, label: act.value });
          break;
        }
        case 'press': await this.human.key(ctx.wc, act.value || 'Enter'); await this.settle(ctx, 300); break;
        case 'scroll': await this.human.scroll(ctx.wc, Number(act.value) || 600); break;
        case 'goto': await this.goto(ctx, act.value); break;
        case 'wait': await sleep(Math.min(Number(act.value) || 1500, 10000)); break;
        case 'extract': {
          let data = act.value;
          try { data = JSON.parse(act.value); } catch {}
          ctx.output(step.name || 'ai_extract', data);
          break;
        }
        default: break;
      }
      history.push(`${act.action} ${desc}${act.value && act.action !== 'extract' ? ` = "${act.value}"` : ''}`);
    }
    throw new Error('AI step used too many actions');
  }
}

module.exports = { Runner, render, lookup, truthy, rowCondition };
