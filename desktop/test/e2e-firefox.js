// End-to-end test of the Firefox engine: account set to Firefox, page stealth,
// recording in the Firefox window, exact replay, and an Excel-driven run.
//   AB_BROWSERS=<folder with Playwright's firefox> xvfb-run -a node test/e2e-firefox.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { _electron } = require('playwright');

const SITE = path.join(__dirname, 'site');
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
async function waitFor(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

(async () => {
  if (!process.env.AB_BROWSERS) { console.log('AB_BROWSERS not set: skipping Firefox test'); return; }
  const { srv, base } = await serve();
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(__dirname, '..')],
    env: { ...process.env, AB_TEST: '1', AB_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ff-')) },
  });
  const failures = [];
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failures.push(m); };
  // drive the Firefox page like a person would (trusted input), via the app's own Playwright handle
  const ff = (op, ...args) => app.evaluate(async (_e, [op, args]) => {
    const t = [...global.__abTest.tabs.values()].reverse().find((x) => x.engine === 'firefox');
    if (!t) throw new Error('no firefox tab');
    const page = t.view.webContents.page;
    if (op === 'click') return page.click(args[0]);
    if (op === 'type') return page.keyboard.type(args[0], { delay: 25 });
    if (op === 'focus') return page.focus(args[0]);
    if (op === 'press') return page.keyboard.press(args[0]);
    if (op === 'wait') return page.waitForSelector(args[0], { timeout: 20000 }).then(() => true);
    if (op === 'eval') return page.evaluate(args[0]);
    if (op === 'url') return page.url();
    return null;
  }, [op, args]);

  try {
    const ui = await waitFor(async () => app.windows().find((w) => w.url().startsWith('app://')), 'ui');
    await ui.waitForSelector('.shell');
    const call = (m, p, body) => ui.evaluate(async ({ m, p, body }) => {
      const b = await window.autobrowser.backend();
      const r = await fetch(`http://127.0.0.1:${b.port}${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-autobrowser-token': b.token }, body: body && JSON.stringify(body) });
      return r.json();
    }, { m, p, body });

    check((await ui.evaluate(() => window.autobrowser.engine.status())).firefoxInstalled, 'Firefox engine detected as installed');
    await ui.click('.railbtn[data-tip="Accounts & logins"]');
    await ui.click('button:has-text("New")');
    await ui.fill('input[placeholder="Store account #1"]', 'Fox');
    await ui.click('.segmented button:has-text("Firefox")');
    await ui.click('button:has-text("Create account profile")');
    const prof = await waitFor(async () => (await call('GET', '/profiles')).find((p) => p.name === 'Fox'), 'profile');
    check(prof.engine === 'firefox', 'account created with the Firefox engine');
    await call('POST', '/credentials', { profile_id: prof.id, site: '127.0.0.1', username: 'alice@shop.test', password: 's3cret!' });
    await ui.evaluate(() => window.autobrowser.profiles.refresh());

    // open the site as that account -> Firefox window
    await ui.evaluate(({ url, pid }) => window.autobrowser.tabs.create({ url, profileId: pid }), { url: `${base}/login.html`, pid: prof.id });
    await ui.waitForSelector('text=This tab is open in Firefox');
    check(await ui.isVisible('.tab .tag:has-text("FF")'), 'tab shows the Firefox badge and a notice in the main window');
    await ff('wait', '#probe:not(:empty)');
    const probe = JSON.parse(await ff('eval', 'document.getElementById("probe").textContent'));
    console.log('  Firefox page sees:', { wd: probe.wd, ua: probe.ua, ts: probe.ts });
    check(probe.wd === false, 'navigator.webdriver is false in Firefox');
    check(/Firefox\/\d+/.test(probe.ua) && !/Chrome|Electron/.test(probe.ua), 'real Firefox user agent');
    check(probe.ts === 'function webdriver() {\n    [native code]\n}', 'patched getter looks native (Firefox format)');

    // record in the Firefox window
    await ui.click('.recbtn');
    await ui.waitForSelector('.recbtn.live');
    await sleep(500);
    await ff('click', '#email'); await ff('type', 'alice@shop.test');
    await ff('click', '#password'); await ff('type', 's3cret!');
    await ff('click', '[data-testid=login-btn]');
    await ff('wait', 'tbody tr');
    await sleep(500);
    await ui.click('.tool:has-text("Pick table")');
    await sleep(400);
    await ff('click', 'tbody tr:nth-child(2) td:nth-child(2)');
    await sleep(600);
    await ui.click('.recbtn');
    const steps = JSON.parse(await ui.evaluate(() => localStorage.getItem('ab.recorder.draft')));
    console.log('  recorded in Firefox:', steps.map((s) => `${s.type}${s.value ? `(${s.value})` : ''}`).join(' → '));
    check(steps.some((s) => s.type === 'type' && s.value === '{{account.username}}') && steps.some((s) => s.type === 'type' && s.value === '{{account.password}}'), 'recorder captured the login typed in Firefox');
    const table = steps.find((s) => s.type === 'extract_table');
    check(table && table.target.columns.join() === 'Order,Customer,Total' && /<table#orders>/.test(table.page_outline || ''), 'table picked in Firefox (with masked page outline)');

    // replay exactly, as the Firefox account, starting logged out
    const flow = await call('POST', '/flows', { name: 'FF orders', start_url: `${base}/login.html`, steps });
    await ff('eval', 'localStorage.clear()');
    const [res] = await ui.evaluate(({ flow, pid }) => window.autobrowser.runner.run({ flow, profileIds: [pid], mode: 'exact' }), { flow, pid: prof.id });
    const run = await call('GET', `/runs/${res.runId}`);
    if (res.status !== 'success') console.log(run.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    check(res.status === 'success' && run.output[0] && run.output[0].data.length === 4, `exact replay in Firefox logged in and extracted 4 rows (${res.status})`);

    // Excel-driven form filling in Firefox
    const b64 = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f)).toString('base64');
    const people = await call('POST', '/datasets', { files: [{ filename: 'applicants.xlsx', content_b64: b64('applicants.xlsx') }] });
    const tgt = (sel) => ({ selectors: [{ kind: 'css', value: sel }] });
    const dflow = await call('POST', '/flows', {
      name: 'FF apply', start_url: `${base}/apply.html`,
      steps: [
        { id: 'g', type: 'goto', url: `${base}/apply.html` },
        { id: 'n', type: 'type', value: '{{row.Name}}', target: tgt('#fullname') },
        { id: 'c', type: 'type', value: '{{row.Case ID}}', target: tgt('#caseid') },
        { id: 's', type: 'select', value: '{{row.City}}', target: tgt('#city') },
        { id: 'k', type: 'check', value: '{{row.Agree}}', target: tgt('#agree') },
        { id: 'b', type: 'click', target: tgt('#save') },
        { id: 'r', type: 'extract_text', name: 'reference', target: tgt('#ref') },
      ],
      data: { dataset_id: people.id, start_step_id: 'g' },
    });
    const [dres] = await ui.evaluate(({ flow, pid }) => window.autobrowser.runner.run({ flow, profileIds: [pid], mode: 'exact' }), { flow: dflow, pid: prof.id });
    const drun = await call('GET', `/runs/${dres.runId}`);
    if (dres.status !== 'success') console.log(drun.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    const subs = JSON.parse(await ff('eval', 'localStorage.subs || "[]"'));
    console.log('  submitted in Firefox:', JSON.stringify(subs));
    check(dres.status === 'success' && subs.length === 3, 'one submission per Excel row in Firefox');
    check(subs[0].name === 'Ana Lima' && subs[0].city === 'Rabat' && subs[0].agree === true && subs[1].agree === false && subs[2].caseid === '1003', 'values, dropdown and checkbox filled correctly in Firefox');
    const rows = drun.output.filter((o) => o.name === '_rows').flatMap((o) => o.data);
    check(rows.length === 3 && rows[2].reference === 'Saved ref R-1003', 'per-row results recorded');
  } catch (e) {
    console.error(e);
    failures.push(String(e.message));
  } finally {
    await app.close().catch(() => {});
    srv.close();
  }
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  process.exit(failures.length ? 1 : 0);
})();
