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
    const outline = table && table.page_outline || '';
    if (process.env.AB_DEBUG) console.log('OUTLINE>>>\n' + outline + '\n<<<');
    check(outline.includes('<table#orders>') && outline.includes('"Customer"') && outline.includes('more <tr>'), 'page code outline captured (structure + headers, repeated rows collapsed)');
    const REAL = /Customer \d|#100\d|\$(7\.50|15\.00|22\.50|30\.00)|alice/;
    check(!REAL.test(outline) && outline.includes('"Xxxxxxxx 9"') && outline.includes('"$99.99"'), 'page outline masks every data value by shape');

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

    // ---------------------------------------------------- Build with AI: goal -> review -> refine
    // The Claude call is intercepted here (no API key in CI); the backend logic is unit-tested.
    await ui.click('.railbtn[data-tip="Settings & AI"]');
    await ui.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
    await ui.click('button:has-text("Save")');
    await ui.waitForSelector('.tag:has-text("key saved")');
    // switch provider: NVIDIA has no key yet, then save one and pick a model
    await ui.click('.segmented button:has-text("NVIDIA")');
    await ui.waitForSelector('.tag:has-text("not set")');
    await ui.fill('input[placeholder="nvapi-…"]', 'nvapi-test');
    await ui.click('button:has-text("Save")');
    await ui.waitForSelector('.tag:has-text("key saved")');
    check(await ui.inputValue('input[list="models-nvidia"]') === 'meta/llama-3.3-70b-instruct', 'NVIDIA default model shown');
    await sleep(300);
    screen('05a-settings-nvidia');
    await ui.click('.segmented button:has-text("Claude")');
    await ui.waitForSelector('input[list="models-anthropic"]');
    check(await ui.inputValue('input[list="models-anthropic"]') === 'claude-opus-5-5', 'switching back keeps the Claude model and key');
    const compileBodies = [];
    await ui.route('**/flows/*/compile', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      compileBodies.push(body);
      const refined = !!body.feedback;
      const updated = {
        ...flow,
        description: body.goal || flow.description,
        compiled: {
          goal: 'Export every order from all pages as CSV',
          summary: 'Login, then export the orders table on every page.',
          understanding: 'You want to log in with each saved account and collect every order (number, customer, total) across all pages into one CSV.',
          matches_goal: refined,
          gaps: refined ? [] : ['You only recorded the first page; I added a loop over the "Next page" button.'],
          suggestions: [
            { title: 'Skip orders already exported', detail: 'Remember the last order number and stop there next time.', instruction: 'Stop when reaching an order number exported in a previous run' },
            { title: 'Add the order link', detail: 'Save the URL of each order row.', instruction: 'Include the _link column in the output' },
          ],
          output_kind: 'data',
          output_fields: [{ name: 'Order', description: 'Order number' }, { name: 'Customer', description: '' }, { name: 'Total', description: '' }],
          variables: [], warnings: [],
          steps: flow.compiled.steps,
        },
      };
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) });
    });
    await ui.click('.railbtn[data-tip="Saved flows"]');
    await ui.click('.card:has-text("Export orders")');
    await ui.click('button:has-text("Review / rebuild")');
    await ui.waitForSelector('text=What are you trying to do?');
    check(await ui.inputValue('input[placeholder^="e.g. name"]') === 'Order, Customer, Total', 'output fields prefilled from the picked table');
    await ui.fill('textarea', 'Export every order from all pages as CSV, for each of my accounts');
    await ui.click('button:has-text("Preview what the AI will see")');
    const sentText = await ui.textContent('pre');
    if (process.env.AB_DEBUG) console.log('LEAKS>>>', sentText.split('\n').filter((l) => REAL.test(l) || /s3cret/.test(l)).join('\n'));
    check(sentText.includes('<table#orders>') && sentText.includes('tbody > tr') && sentText.includes('Export every order'), 'AI preview contains the page code and the goal');
    check(!/alice@shop\.test|s3cret/.test(sentText) && !REAL.test(sentText), 'AI preview contains no page data or credentials (private mode)');
    await sleep(200);
    screen('05b-ai-preview');
    await ui.click('button:has-text("Hide preview")');
    await sleep(200);
    screen('05-goal');
    await ui.click('button:has-text("Build automation")');
    await ui.waitForSelector('text=What I understood');
    check(compileBodies[0].goal.startsWith('Export every order') && compileBodies[0].output_kind === 'data' && compileBodies[0].output_fields.length === 3, 'goal, output kind and fields sent to the AI build');
    await ui.click('.card:has-text("Add the order link")');
    await ui.fill('textarea', 'Only orders above $10');
    await sleep(200);
    screen('06-review');
    await ui.click('button:has-text("Apply 1 & rebuild")');
    await ui.waitForSelector('.tag:has-text("matches your goal")');
    check(/_link column/.test(compileBodies[1].feedback) && /above \$10/.test(compileBodies[1].feedback), 'picked suggestion + feedback sent as refinement');
    await ui.click('button:has-text("Looks good")');
    await ui.waitForSelector('text=AI build');
    await sleep(400);
    screen('07-flow-detail');

    // ---------------------------------------------------- Excel-driven form filling (2 files joined, checkbox, per-row results)
    await ui.unroute('**/flows/*/compile');
    const FIX = path.join(__dirname, 'fixtures');
    const call = (m, p, body) => ui.evaluate(async ({ m, p, body }) => {
      const b = await window.autobrowser.backend();
      const r = await fetch(`http://127.0.0.1:${b.port}${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-autobrowser-token': b.token }, body: body && JSON.stringify(body) });
      return r.json();
    }, { m, p, body });
    const up = (file) => call('POST', '/datasets', { files: [{ filename: file, content_b64: fs.readFileSync(path.join(FIX, file)).toString('base64') }] });
    const people = await up('applicants.xlsx');
    const phones = await up('phones.csv');
    check(people.row_count === 3 && people.columns.join() === 'Case ID,Name,Agree,City', 'Excel imported (3 rows, 4 columns)');
    check(phones.columns.join() === 'Case ID,phone', 'CSV imported (; separated)');

    // record one application using row 1 of the Excel
    await ui.fill('.address input', `${base}/apply.html`);
    await ui.press('.address input', 'Enter');
    const apply = await tabPage(/apply\.html/);
    await apply.waitForSelector('#app');
    await ui.click('.railbtn[data-tip="Recorder"]');
    ui.once('dialog', (d) => d.accept());
    await ui.click('button[title="Clear"]');
    await waitFor(async () => (await ui.evaluate(() => localStorage.getItem('ab.recorder.draft'))) === '[]', 'recorder cleared');
    await ui.selectOption('select:has(option:text("No data: record a one-off flow"))', { label: 'applicants · Applicants (3 rows)' }).catch(async () => {
      await ui.selectOption('select:has(option:text("No data: record a one-off flow"))', people.id);
    });
    await ui.waitForSelector('text=Record with row');
    await ui.click('.recbtn');
    await ui.waitForSelector('.recbtn.live');
    await sleep(300);
    await apply.click('#fullname'); await apply.keyboard.type('Ana Lima', { delay: 15 });
    await apply.click('#caseid'); await apply.keyboard.type('1001', { delay: 15 });
    await apply.focus('#city');
    await apply.keyboard.press('ArrowDown'); // real (trusted) keyboard choice, like a person: "—" -> "Rabat"
    await apply.evaluate(() => document.getElementById('city').blur());
    await apply.click('#agree');
    await apply.click('#phone'); await apply.keyboard.type('0600111222', { delay: 15 });
    await apply.click('#save');
    await apply.waitForSelector('#ref:not(:empty)');
    await ui.click('.tool:has-text("Pick text")');
    await sleep(300);
    await apply.click('#ref');
    await sleep(500);
    await ui.click('.recbtn');
    await sleep(300);
    let rsteps = JSON.parse(await ui.evaluate(() => localStorage.getItem('ab.recorder.draft')));
    console.log('  recorded:', rsteps.map((s) => `${s.type}${s.value ? `(${s.value})` : ''}`).join(' → '));
    check(rsteps.some((s) => s.type === 'type' && s.value === '{{row.Name}}') && rsteps.some((s) => s.type === 'type' && s.value === '{{row.Case ID}}'), 'typed values from the row became {{row.Name}} / {{row.Case ID}}');
    check(rsteps.some((s) => s.type === 'select' && s.value === '{{row.City}}'), 'dropdown choice became {{row.City}}');
    check(rsteps.some((s) => s.type === 'check' && s.value === 'true'), 'checkbox recorded as a "set on" step, not a click');

    // map the checkbox to the Agree column and the phone to the joined file, name the extracted value
    const checkCard = ui.locator('.step', { hasText: 'Set Consent given' });
    await checkCard.locator('select[title="Use a column of your data"]').selectOption('Agree');
    const nameCard = ui.locator('.step', { hasText: 'Type into Full name' });
    await nameCard.locator('select[title^="Format the value"]').selectOption('upper');
    check(await nameCard.locator('input.grow').first().inputValue() === '{{row.Name | upper}}', 'Format menu added "| upper" to the value');
    await nameCard.locator('text=ANA LIMA').waitFor({ timeout: 5000 });
    check(true, 'live preview shows the formatted value for row 1 (ANA LIMA)');
    const phoneCard = ui.locator('.step', { hasText: 'Type into Phone' });
    await phoneCard.locator('input.grow').first().fill('{{row.phone}}');
    const textCard = ui.locator('.step', { hasText: 'Extract text' });
    await textCard.locator('input[placeholder^="Output name"]').fill('reference');
    check((await ui.locator('.step:has-text("Repeats for each data row from here")').count()) === 1, 'per-row start marker shown');
    await ui.fill('input[placeholder^="Flow name"]', 'Submit applications');
    await ui.click('footer button:has-text("Save")');
    await ui.waitForSelector('text=Saved "Submit applications"');
    screen('09-recorder-data');

    // link the phone list by Case ID (like VLOOKUP) in the flow's Data card
    await ui.click('.railbtn[data-tip="Saved flows"]');
    await ui.click('.card:has-text("Submit applications")');
    await ui.click('button:has-text("Link another file")');
    await ui.click('button:has-text("Save data settings")');
    await ui.waitForSelector('text=Rows this flow will process');
    const dataRows = await call('GET', `/flows/${(await call('GET', '/flows')).find((f) => f.name === 'Submit applications').id}/data-rows`);
    check(dataRows.total === 3 && dataRows.rows[0].phone === '0600111222' && dataRows.rows[1].phone === undefined, 'second file linked by Case ID (phone joined)');
    await sleep(300);
    screen('10-flow-data');

    // run it: once per row
    await apply.evaluate(() => { localStorage.subs = '[]'; });
    await ui.click('button:has-text("Run")');
    await waitFor(async () => (await ui.$('.tag.ok:has-text("data rows")')) || (await call('GET', '/runs?limit=1'))[0]?.finished, 'data run to finish', 120000);
    const runRes = (await call('GET', '/runs?limit=1'))[0];
    if (runRes.status !== 'success') console.log(runRes.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    const subs = JSON.parse(await (await tabPage(/apply\.html/)).evaluate(() => localStorage.subs || '[]'));
    console.log('  submitted:', JSON.stringify(subs));
    check(runRes.status === 'success', `data run succeeded (${runRes.status})`);
    check(subs.length === 3, `one submission per Excel row (got ${subs.length})`);
    check(subs[0] && subs[0].name === 'ANA LIMA' && subs[0].city === 'Rabat' && subs[0].agree === true && subs[0].phone === '0600111222', 'row 1 filled correctly (incl. joined phone, ticked)');
    check(subs[1] && subs[1].name === 'BO CHEN' && subs[1].city === 'Fes' && subs[1].agree === false && subs[1].phone === '', 'row 2: checkbox left unticked, no phone match');
    check(subs[2] && subs[2].caseid === '1003' && subs[2].agree === true && subs[2].phone === '0700333444', 'row 3 filled correctly');
    const results = runRes.output.filter((o) => o.name === '_rows').flatMap((o) => o.data);
    check(results.length === 3 && results.every((r) => r._status === 'success') && results[2].reference === 'Saved ref R-1003', 'per-row status + extracted reference recorded');
    // Run opens the Runs panel by itself
    await ui.waitForSelector('text=data rows done');
    await sleep(300);
    screen('11-runs-data');

    // ---------------------------------------------------- "for each item": price only on each product's own page
    const recordItems = async (listUrl, clickSel, withTable) => {
      await ui.fill('.address input', listUrl);
      await ui.press('.address input', 'Enter');
      const list = await tabPage(/products\.html/);
      await list.waitForSelector('.card');
      if (!(await ui.isVisible('.panel button[title="Clear"]'))) await ui.click('.railbtn[data-tip="Recorder"]');
      ui.once('dialog', (d) => d.accept());
      await ui.click('button[title="Clear"]');
      await waitFor(async () => (await ui.evaluate(() => localStorage.getItem('ab.recorder.draft'))) === '[]', 'cleared');
      await ui.selectOption('.panel select:has(option:text("No data: record a one-off flow"))', '');
      await ui.click('.recbtn');
      await ui.waitForSelector('.recbtn.live');
      await sleep(300);
      if (withTable) {
        await ui.click('.tool:has-text("Pick table")');
        await sleep(300);
        await list.click('.card:nth-child(2) p');
        await sleep(400);
      }
      await list.click(clickSel);
      const prod = await tabPage(/product\.html\?id=/);
      await prod.waitForSelector('#price:not(:empty)');
      await sleep(600);
      await ui.click('.tool:has-text("Pick text")');
      await sleep(300);
      await prod.click('#price');
      await sleep(500);
      await ui.click('.recbtn');
      await sleep(300);
      if (withTable) await ui.locator('.step', { hasText: 'Extract table' }).locator('input[placeholder^="Output name"]').fill('products');
      await ui.locator('.step', { hasText: 'Extract text' }).locator('input[placeholder^="Output name"]').fill('price');
      await ui.click('button:has-text("Repeat the next steps for every item")');
      return JSON.parse(await ui.evaluate(() => localStorage.getItem('ab.recorder.draft')));
    };

    let isteps = await recordItems(`${base}/products.html`, '.card:nth-child(2) a', true);
    console.log('  recorded:', isteps.map((s) => s.type + (s.type === 'loop' ? `[${(s.steps || []).map((c) => c.type).join(',')}]` : '')).join(' → '));
    const loopStep = isteps.find((s) => s.type === 'loop');
    check(loopStep && loopStep.loop.over === 'items' && loopStep.loop.from === 'products' && loopStep.loop.open === 'link', 'click inside the picked list became "for each item in products" (open by link)');
    check(loopStep && loopStep.steps.length === 1 && loopStep.steps[0].type === 'extract_text' && loopStep.steps[0].name === 'price', 'steps done on the product page became the loop body');
    screen('13-for-each-item');
    await ui.fill('input[placeholder^="Flow name"]', 'Product prices');
    await ui.click('footer button:has-text("Save")');
    await ui.waitForSelector('text=Saved "Product prices"');
    const pflow = (await call('GET', '/flows')).find((f) => f.name === 'Product prices');
    const [pres] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), pflow);
    const prun = await call('GET', `/runs/${pres.runId}`);
    if (pres.status !== 'success') console.log(prun.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    const details = prun.output.filter((o) => o.name === 'products_details').flatMap((o) => o.data);
    console.log('  products_details:', JSON.stringify(details.map((d) => [d.col_1, d.price, d._status])));
    check(pres.status === 'success' && details.length === 4, `opened all 4 products from one recording (${details.length})`);
    check(details.map((d) => d.price).join() === '$12.50,$25.00,$37.50,$50.00' && details[2].col_1 === 'Bookshelf', 'each product price merged with its list row (name, SKU, link)');

    // cards without links: open each by clicking its row on the list page
    isteps = await recordItems(`${base}/products.html?js=1`, '.card:nth-child(3) .title', false);
    const jsLoop = isteps.find((s) => s.type === 'loop');
    check(jsLoop && jsLoop.loop.open === 'click' && /\.card/.test(jsLoop.loop.row_selector), 'list without links: loop opens each item by clicking its row');
    await ui.fill('input[placeholder^="Flow name"]', 'Product prices JS');
    await ui.click('footer button:has-text("Save")');
    await ui.waitForSelector('text=Saved "Product prices JS"');
    const jflow = (await call('GET', '/flows')).find((f) => f.name === 'Product prices JS');
    const [jres] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), jflow);
    const jrun = await call('GET', `/runs/${jres.runId}`);
    if (jres.status !== 'success') console.log(jrun.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    const jd = jrun.output.filter((o) => o.name === 'items_details').flatMap((o) => o.data);
    check(jres.status === 'success' && jd.map((d) => d.price).join() === '$12.50,$25.00,$37.50,$50.00' && jd[3].col_1 === 'Monitor Arm', `clicked through all 4 JS-only items (${jd.length})`);

    // ---------------------------------------------------- pause for me (CAPTCHA, human in the loop)
    const css = (sel) => ({ selectors: [{ kind: 'css', value: sel }] });
    const runWithHuman = async (name, steps, solve) => {
      const fl = await call('POST', '/flows', { name, start_url: `${base}/captcha.html`, steps });
      const runP = ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), fl);
      await ui.waitForSelector('.pausebar', { timeout: 30000 });
      const msg = await ui.textContent('.pausebar');
      screen(`14-paused-${name.replace(/\W+/g, '-')}`);
      await solve();
      await ui.click('.pausebar button:has-text("Continue")');
      const [res] = await runP;
      return { res, msg, run: await call('GET', `/runs/${res.runId}`) };
    };
    const solveCaptcha = async () => { const pg = await tabPage(/captcha\.html/); await pg.click('#robot'); };
    const tail = [
      { id: 'n', type: 'type', value: 'Zed', target: css('#name') },
      { id: 's', type: 'click', target: css('#send') },
      { id: 'd', type: 'extract_text', name: 'done', target: css('#done:not(:empty)') },
    ];
    let h = await runWithHuman('Pause step', [
      { id: 'g', type: 'goto', url: `${base}/captcha.html` },
      { id: 'p', type: 'pause', value: 'Tick the CAPTCHA, then press Continue', condition: { captcha: true } },
      ...tail,
    ], solveCaptcha);
    check(/Tick the CAPTCHA/.test(h.msg), 'pause step shows its message in the pause bar');
    check(h.res.status === 'success' && h.run.output.some((o) => o.data === 'Sent: Zed'), 'run continued after the person solved it and pressed Continue');
    h = await runWithHuman('Auto pause', [{ id: 'g', type: 'goto', url: `${base}/captcha.html` }, ...tail], solveCaptcha);
    check(/CAPTCHA \(reCAPTCHA\)/.test(h.msg), 'a failing step with a CAPTCHA on the page paused automatically');
    check(h.res.status === 'success' && h.run.output.some((o) => o.data === 'Sent: Zed'), 'the failed step was retried after Continue and the run succeeded');
    // a pause step whose condition is false does not stop the run
    const nf = await call('POST', '/flows', { name: 'No captcha', steps: [{ id: 'g', type: 'goto', url: `${base}/apply.html` }, { id: 'p', type: 'pause', value: 'x', condition: { captcha: true } }] });
    const [nres] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), nf);
    check(nres.status === 'success' && !(await ui.$('.pausebar')), '"only when a CAPTCHA is on the page" skips the pause when there is none');

    // ---------------------------------------------------- results back into the Excel + re-run failed rows
    const ppl = await up('applicants.xlsx');
    const wflow = await call('POST', '/flows', {
      name: 'Writeback demo', start_url: `${base}/apply.html`,
      steps: [
        { id: 'g', type: 'goto', url: `${base}/apply.html` },
        { id: 'n', type: 'type', value: '{{row.Name}}', target: css('#fullname') },
        { id: 'c', type: 'type', value: '{{row.Case ID}}', target: css('#caseid') },
        // fails on purpose for Bo Chen only
        { id: 'x', type: 'wait', ms: 1500, target: css('#does-not-exist'), condition: { row: 'Name', op: 'equals', value: 'Bo Chen' } },
        { id: 'b', type: 'click', target: css('#save') },
        { id: 'r', type: 'extract_text', name: 'reference', target: css('#ref:not(:empty)') },
      ],
      data: { dataset_id: ppl.id, start_step_id: 'g' },
    });
    const [wres] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), wflow);
    const wrun = await call('GET', `/runs/${wres.runId}`);
    const wrows = wrun.output.filter((o) => o.name === '_rows').flatMap((o) => o.data);
    check(wrun.dataset_id === ppl.id && wrows.map((r) => r._status).join() === 'success,failed,success', 'data run remembers its data file; row 2 failed, others succeeded');
    const wds = await call('GET', `/datasets/${ppl.id}`);
    if (process.env.AB_DEBUG) console.log('DEBUG wds', JSON.stringify(wds.columns), JSON.stringify(wds.rows.slice(0, 3)), JSON.stringify(wrows));
    check(wds.columns.includes('AutoBrowser status') && wds.rows[1]['AutoBrowser status'] === 'failed' && wds.rows[2].reference === 'Saved ref R-1003', 'statuses + extracted values stored in the data source');
    const upd = await ui.evaluate(async (rid) => {
      const b = await window.autobrowser.backend();
      const r = await fetch(`http://127.0.0.1:${b.port}/runs/${rid}/updated-file`, { headers: { 'x-autobrowser-token': b.token } });
      return { ok: r.ok, name: decodeURIComponent(r.headers.get('x-filename') || ''), size: (await r.arrayBuffer()).byteLength };
    }, wres.runId);
    if (process.env.AB_DEBUG) console.log('DEBUG upd', JSON.stringify(upd));
    check(upd.ok && upd.name === 'applicants.xlsx' && upd.size > 1000, 'original Excel with results can be downloaded under its own name');
    // re-run only the failed row from the Runs panel
    await ui.evaluate(() => window.dispatchEvent(new Event('focus')));
    if (!(await ui.isVisible('.panel h2:text("Runs")'))) await ui.click('.railbtn[data-tip="Runs & results"]');
    await ui.click('.panel button[title="Refresh"], .panel button[aria-label="Refresh"]');
    const card = ui.locator('.card', { hasText: 'Writeback demo' }).first();
    await card.locator('button:has-text("Re-run 1 failed")').waitFor({ timeout: 10000 });
    check(await card.locator('button:has-text("Your file + results")').isVisible(), 'Runs panel offers "Your file + results"');
    screen('15-rerun-failed');
    await card.locator('button:has-text("Re-run 1 failed")').click();
    const rerun = await waitFor(async () => {
      const list = await call('GET', '/runs?limit=3');
      const r = list.find((x) => x.flow_id === wflow.id && x.id !== wres.runId && x.finished);
      return r || null;
    }, 'rerun finished', 60000);
    const rr = rerun.output.filter((o) => o.name === '_rows').flatMap((o) => o.data);
    check(rr.length === 1 && rr[0]._row === 2 && rr[0].Name === 'Bo Chen', 're-run processed only the failed row');

    // ---------------------------------------------------- pop-up windows: recording + runs follow them
    await ui.fill('.address input', `${base}/popup.html`);
    await ui.press('.address input', 'Enter');
    const shop = await tabPage(/popup\.html/);
    await shop.waitForSelector('#pay');
    if (!(await ui.isVisible('.panel button[title="Clear"]'))) await ui.click('.railbtn[data-tip="Recorder"]');
    ui.once('dialog', (d) => d.accept());
    await ui.click('button[title="Clear"]');
    await waitFor(async () => (await ui.evaluate(() => localStorage.getItem('ab.recorder.draft'))) === '[]', 'cleared');
    await ui.click('.recbtn');
    await ui.waitForSelector('.recbtn.live');
    await sleep(300);
    await shop.click('#pay');
    const bank = await tabPage(/confirm\.html/);
    await bank.waitForSelector('#what:not(:empty)');
    check(!!(await ui.waitForSelector('.tab.active:has-text("Confirm payment")', { timeout: 8000 }).catch(() => null)), 'pop-up window opened as a tab and became active');
    await sleep(500);
    await bank.click('#confirm');
    await shop.waitForSelector('#status:text("Paid 7")', { timeout: 10000 });
    check(true, 'pop-up kept its link to the opener (postMessage reached the checkout page)');
    await waitFor(async () => !app.windows().some((w) => /confirm\.html/.test(w.url())), 'pop-up closed itself');
    await sleep(500);
    await ui.click('.tool:has-text("Pick text")');
    await sleep(300);
    await shop.click('#status');
    await sleep(500);
    await ui.click('.recbtn');
    const psteps = JSON.parse(await ui.evaluate(() => localStorage.getItem('ab.recorder.draft')));
    console.log('  recorded:', psteps.map((s) => `${s.type}${s.target?.text ? `("${s.target.text}")` : ''}`).join(' → '));
    check(psteps.filter((s) => s.type === 'click').length === 2 && psteps.some((s) => s.type === 'click' && /Confirm/.test(s.target?.text || '')), 'recorder followed into the pop-up (Confirm click recorded)');
    check(psteps.some((s) => s.type === 'extract_text'), 'recorder came back to the checkout page after the pop-up closed');
    const popFlow = await call('POST', '/flows', { name: 'Pay in pop-up', start_url: `${base}/popup.html`, steps: psteps });
    const [pres2] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), popFlow);
    const prun2 = await call('GET', `/runs/${pres2.runId}`);
    if (pres2.status !== 'success') console.log(prun2.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    check(pres2.status === 'success' && prun2.output.some((o) => o.data === 'Paid 7'), 'run followed the pop-up, confirmed, came back and read "Paid 7"');
    check(prun2.log.some((l) => /opened a new tab/.test(l.msg)) && prun2.log.some((l) => /back to the previous page/.test(l.msg)), 'run log shows the switch to the pop-up and back');

    // ---------------------------------------------------- file upload + download per row
    const recordOn = async (url, pageRe, actions) => {
      await ui.fill('.address input', url);
      await ui.press('.address input', 'Enter');
      const pg = await tabPage(pageRe);
      await pg.waitForLoadState('load');
      if (!(await ui.isVisible('.panel button[title="Clear"]'))) await ui.click('.railbtn[data-tip="Recorder"]');
      ui.once('dialog', (d) => d.accept());
      await ui.click('button[title="Clear"]');
      await waitFor(async () => (await ui.evaluate(() => localStorage.getItem('ab.recorder.draft'))) === '[]', 'cleared');
      await ui.click('.recbtn');
      await ui.waitForSelector('.recbtn.live');
      await sleep(300);
      await actions(pg);
      await sleep(600);
      await ui.click('.recbtn');
      return JSON.parse(await ui.evaluate(() => localStorage.getItem('ab.recorder.draft')));
    };
    const usteps = await recordOn(`${base}/upload.html`, /upload\.html/, async (pg) => {
      await pg.click('label.pick').catch(() => {}); // the system dialog would open here; tests set the file directly
      await pg.setInputFiles('#doc', path.join(FIX, 'doc_a.pdf'));
      await sleep(300);
      await pg.click('#send');
    });
    console.log('  recorded:', usteps.map((s) => `${s.type}${s.value ? `(${s.value})` : ''}`).join(' → '));
    check(usteps.some((s) => s.type === 'upload' && s.value === 'doc_a.pdf'), 'choosing a file was recorded as an upload step');
    check(!usteps.some((s) => s.type === 'click' && /Choose PDF/.test(s.target?.text || '')), 'the click that opens the file dialog is not replayed');
    // upload each PDF of a PDF data source into the form
    const b64f = (f) => fs.readFileSync(path.join(FIX, f)).toString('base64');
    const pdfs = await call('POST', '/datasets', { files: [{ filename: 'doc_a.pdf', content_b64: b64f('doc_a.pdf') }, { filename: 'doc_b.pdf', content_b64: b64f('doc_b.pdf') }] });
    check(pdfs.columns.includes('file_path'), 'PDF data source offers file_path for uploads');
    const upFlow = await call('POST', '/flows', {
      name: 'Upload PDFs', start_url: `${base}/upload.html`, data: { dataset_id: pdfs.id, start_step_id: 'g' },
      steps: [
        { id: 'g', type: 'goto', url: `${base}/upload.html` },
        { id: 'u', type: 'upload', value: '{{row.file_path}}', target: css('#doc') },
        { id: 's', type: 'click', target: css('#send') },
        { id: 'r', type: 'extract_text', name: 'result', target: css('#result:not(:empty)') },
      ],
    });
    const [ures] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), upFlow);
    const urun = await call('GET', `/runs/${ures.runId}`);
    if (ures.status !== 'success') console.log(urun.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    const ur = urun.output.filter((o) => o.name === '_rows').flatMap((o) => o.data);
    console.log('  upload results:', JSON.stringify(ur.map((r) => r.result)));
    check(ures.status === 'success' && ur.length === 2 && ur.every((r) => /^Received doc_[ab]\.pdf, \d+ bytes, starts with %PDF-$/.test(r.result)), 'each row uploaded its own PDF (real file content, hidden file field)');

    // downloads: the recorder turns the click into a download step; runs save one file per row
    const dsteps = await recordOn(`${base}/download.html?id=7`, /download\.html/, async (pg) => { await pg.click('#get'); });
    check(dsteps.some((s) => s.type === 'download' && s.value === 'receipt.txt'), 'a click that downloaded a file was recorded as a download step');
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-dl-'));
    const dlData = await up('applicants.xlsx');
    const dlFlow = await call('POST', '/flows', {
      name: 'Receipts', data: { dataset_id: dlData.id, start_step_id: 'g' },
      steps: [
        { id: 'g', type: 'goto', url: `${base}/download.html?id={{row.Case ID}}` },
        { id: 'd', type: 'download', value: 'receipt_{{row.Case ID}}', folder: dlDir, target: css('#get') },
      ],
    });
    const [dres] = await ui.evaluate((flow) => window.autobrowser.runner.run({ flow, profileIds: [null], mode: 'exact' }), dlFlow);
    const drun2 = await call('GET', `/runs/${dres.runId}`);
    if (dres.status !== 'success') console.log(drun2.log.map((l) => `    ${l.level}: ${l.msg}`).join('\n'));
    const files = fs.readdirSync(dlDir).sort();
    console.log('  downloaded:', files.join(', '));
    check(dres.status === 'success' && files.join() === 'receipt_1001.txt,receipt_1002.txt,receipt_1003.txt', 'one file per row, named from the row (site extension kept)');
    check(fs.readFileSync(path.join(dlDir, 'receipt_1003.txt'), 'utf8') === 'Receipt for case 1003', 'downloaded file has the right content');
    const dr = drun2.output.filter((o) => o.name === '_rows').flatMap((o) => o.data);
    check(dr.length === 3 && dr[0].download === path.join(dlDir, 'receipt_1001.txt'), 'saved path recorded in each row\'s results');
    await ui.click('.railbtn[data-tip="Accounts & logins"]');
    await sleep(400);
    screen('08-accounts');
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
