// End-to-end test: launches the real app, records a login + table extraction on a
// local demo shop, then replays it (exact mode) and runs a hand-written
// "compiled" flow (login + pagination loop) for a saved account.
//
//   xvfb-run -a node test/e2e.js        (Linux CI)
//   node test/e2e.js                    (Windows/macOS)
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');
const { _electron } = require('playwright');

const SITE = path.join(__dirname, 'site');
const SHOTS = process.env.AB_SHOTS || path.join(os.tmpdir(), 'ab-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(p));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function waitFor(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(200);
  }
}

function screen(name) {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return;
  try { execSync(`import -window root ${path.join(SHOTS, name)}.png`); } catch {}
}

(async () => {
  const { srv, base } = await serve();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(__dirname, '..')],
    env: { ...process.env, AB_USER_DATA: userData },
  });
  const failures = [];
  const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures.push(msg); };

  try {
    const ui = await waitFor(async () => app.windows().find((w) => w.url().startsWith('app://')), 'ui window');
    await ui.waitForSelector('.shell');
    await sleep(800);
    screen('01-start');

    const tabPage = async (re) => waitFor(async () => app.windows().find((w) => re.test(w.url())), `tab ${re}`);

    // ---------------------------------------------------- browse + stealth probe
    await ui.fill('.address input', `${base}/login.html`);
    await ui.press('.address input', 'Enter');
    const login = await tabPage(/login\.html/);
    await login.waitForSelector('#probe:not(:empty)');
    const probe = JSON.parse(await login.textContent('#probe'));
    console.log('  page sees:', probe);
    check(probe.wd === false, 'navigator.webdriver is false');
    check(probe.chrome === 'object', 'window.chrome exists');
    check(!/Electron|autobrowser/i.test(probe.ua), 'user agent has no Electron/app token');
    check((probe.brands || []).some((b) => b.brand === 'Google Chrome'), 'userAgentData has Google Chrome brand');
    check(/\[native code\]/.test(probe.ts), 'patched getters look native');

    // ---------------------------------------------------- record
    await ui.click('.recbtn');
    await ui.waitForSelector('.recbtn.live');
    await sleep(400);
    await login.click('#email');
    await login.keyboard.type('alice@shop.test', { delay: 20 });
    await login.click('#password');
    await login.keyboard.type('s3cret!', { delay: 20 });
    await login.click('[data-testid=login-btn]');
    const orders = await tabPage(/orders\.html\?page=1/);
    await orders.waitForSelector('tbody tr');
    await sleep(500);
    await ui.click('.tool:has-text("Pick table")');
    await sleep(300);
    await orders.hover('tbody tr:nth-child(2) td:nth-child(2)');
    await sleep(200);
    screen('02-pick-table');
    await orders.click('tbody tr:nth-child(2) td:nth-child(2)');
    await sleep(400);
    await orders.click('#next');
    await tabPage(/page=2/);
    await sleep(600);
    screen('03-recorded');
    await ui.click('.recbtn');

    const steps = JSON.parse(await ui.evaluate(() => localStorage.getItem('ab.recorder.draft')));
    console.log('  recorded:', steps.map((s) => `${s.type}${s.value ? `(${s.value})` : ''}`).join(' → '));
    check(steps[0].type === 'goto', 'starts with goto');
    check(steps.some((s) => s.type === 'type' && s.value === '{{account.username}}'), 'email templated to {{account.username}}');
    check(steps.some((s) => s.type === 'type' && s.value === '{{account.password}}' && s.secret), 'password stored as secret template');
    check(steps.some((s) => s.type === 'click' && s.target.selectors[0].value.includes('login-btn')), 'login click uses data-testid');
    const table = steps.find((s) => s.type === 'extract_table');
    check(table && table.target.columns.join() === 'Order,Customer,Total' && table.target.sample.length === 3, 'table picked with headers + sample');
    check(!steps.some((s) => s.type === 'goto' && /orders/.test(s.url)), 'navigations caused by clicks are not separate steps');

    // ---------------------------------------------------- account + saved flow (via backend API)
    const ids = await ui.evaluate(async ({ steps, base }) => {
      const b = await window.autobrowser.backend();
      const call = (m, p, body) => fetch(`http://127.0.0.1:${b.port}${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-autobrowser-token': b.token }, body: body && JSON.stringify(body) }).then((r) => r.json());
      const prof = await call('POST', '/profiles', { name: 'Alice', color: '#1fa463' });
      await call('POST', '/credentials', { profile_id: prof.id, site: '127.0.0.1', username: 'alice@shop.test', password: 's3cret!' });
      const flow = await call('POST', '/flows', { name: 'Export orders', start_url: `${base}/login.html`, steps: steps.filter((s) => !(s.type === 'click' && /next/i.test(s.target?.text || ''))) });
      const compiled = {
        summary: 'Login then export every page', variables: [], warnings: [],
        steps: [
          { id: 'g', type: 'goto', url: `${base}/login.html` },
          { id: 'l', type: 'login' },
          { id: 'w', type: 'wait', target: { selectors: [{ kind: 'css', value: '#orders' }] } },
          { id: 'p', type: 'loop', loop: { over: 'until_missing', selector: '#next', max: 10 }, steps: [
            { id: 'e', type: 'extract_table', name: 'orders', target: { selectors: [{ kind: 'css', value: '#orders' }], row_selector: 'tbody > tr' } },
          ] },
        ],
      };
      await call('PATCH', `/flows/${flow.id}`, { compiled });
      await window.autobrowser.profiles.refresh();
      return { profileId: prof.id, flowId: flow.id };
    }, { steps, base });

    // ---------------------------------------------------- replay exact (fresh profile = not logged in)
    const flows = await ui.evaluate(async () => {
      const b = await window.autobrowser.backend();
      return fetch(`http://127.0.0.1:${b.port}/flows`, { headers: { 'x-autobrowser-token': b.token } }).then((r) => r.json());
    });
    const flow = flows.find((f) => f.id === ids.flowId);
    const t0 = Date.now();
    const [exact] = await ui.evaluate(({ flow, pid }) => window.autobrowser.runner.run({ flow, profileIds: [pid], mode: 'exact' }), { flow, pid: ids.profileId });
    console.log(`  exact run ${exact.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    screen('04-after-exact');
    const getRun = (id) => ui.evaluate(async (id) => {
      const b = await window.autobrowser.backend();
      return fetch(`http://127.0.0.1:${b.port}/runs/${id}`, { headers: { 'x-autobrowser-token': b.token } }).then((r) => r.json());
    }, id);
    const r1 = await getRun(exact.runId);
    if (exact.status !== 'success') console.log(r1.log.map((l) => l.msg).join('\n'));
    check(exact.status === 'success', 'exact replay succeeded (filled login from vault)');
    check(r1.output[0] && r1.output[0].data.length === 4 && r1.output[0].data[0].Order === '#1001', 'exact replay extracted 4 rows');

    // ---------------------------------------------------- compiled flow: login + pagination loop
    await ui.evaluate(async (pid) => window.autobrowser.profiles.clearData(pid), ids.profileId);
    const [comp] = await ui.evaluate(({ flow, pid }) => window.autobrowser.runner.run({ flow, profileIds: [pid], mode: 'compiled' }), { flow, pid: ids.profileId });
    const r2 = await getRun(comp.runId);
    if (comp.status !== 'success') console.log(r2.log.map((l) => l.msg).join('\n'));
    const rows = r2.output.flatMap((o) => o.data);
    check(comp.status === 'success', 'compiled flow succeeded');
    check(rows.length === 12 && rows[11].Order === '#1012', `pagination loop collected all 12 rows (got ${rows.length})`);

    // ---------------------------------------------------- UI panels screenshot
    await ui.click('.railbtn[data-tip="Saved flows"]');
    await ui.click('.card:has-text("Export orders")');
    await sleep(500);
    screen('05-flows');
    await ui.click('.railbtn[data-tip="Accounts & logins"]');
    await sleep(400);
    screen('06-accounts');
  } catch (e) {
    console.error(e);
    failures.push(String(e.message));
    screen('99-error');
  } finally {
    await app.close().catch(() => {});
    srv.close();
  }
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  process.exit(failures.length ? 1 : 0);
})();
