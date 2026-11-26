const test = require('node:test');
const assert = require('node:assert');
const { render, preview } = require('../../src/template');

const vars = {
  row: { Name: 'ana lima', 'Case ID': '1001', Date: '2024-05-01', Born: '07/03/1990', Serial: '45413', Phone: '+212 600-111-222', Amount: '1 250,5', Empty: '', City: 'Rabat', Agree: 'x', extra: { city: 'Fes' } },
  account: { username: 'me@x.com' },
  today: '2026-11-26',
};
const r = (s) => render(s, vars);

test('plain values and nested / spaced keys', () => {
  assert.equal(r('{{row.Name}}'), 'ana lima');
  assert.equal(r('{{row.Case ID}}'), '1001');
  assert.equal(r('{{row.extra.city}}'), 'Fes');
  assert.equal(r('{{ account.username }}'), 'me@x.com');
  assert.equal(r('{{row.missing}}'), '');
  assert.equal(r('{{row}} a.title'), '{{row}} a.title'); // row-scope marker kept
});

test('text filters', () => {
  assert.equal(r('{{row.Name | upper}}'), 'ANA LIMA');
  assert.equal(r('{{row.Name | title}}'), 'Ana Lima');
  assert.equal(r('{{row.Name | first | title}}'), 'Ana');
  assert.equal(r('{{row.Name | last}}'), 'lima');
  assert.equal(r('{{row.Phone | digits}}'), '212600111222');
  assert.equal(r('{{row.Phone | digits | slice:3}}'), '600111222');
  assert.equal(r('{{row.Empty | default:"N/A"}}'), 'N/A');
  assert.equal(r('{{row.City | replace:"Rabat":"RBA"}}'), 'RBA');
  assert.equal(r('{{row.Case ID | pad:6}}'), '001001');
  assert.equal(r('{{row.Agree | yesno:Oui:Non}}'), 'Oui');
  assert.equal(r('{{row.Name | split:" ":1}}'), 'lima');
});

test('dates', () => {
  assert.equal(r('{{row.Date | date:DD/MM/YYYY}}'), '01/05/2024');
  assert.equal(r('{{row.Born | date:YYYY-MM-DD}}'), '1990-03-07'); // day first
  assert.equal(r('{{row.Serial | date:DD.MM.YYYY}}'), '01.05.2024'); // Excel serial day
  assert.equal(r('{{row.Born | parsedate:MM/DD/YYYY | date:D/M/YY}}'), '3/7/90');
  assert.equal(r('{{"2024-05-01 14:30" | date:DD/MM/YYYY HH:mm}}'), '01/05/2024 14:30');
  assert.equal(r('{{today | date:DD-MM-YYYY}}'), '26-11-2026');
});

test('numbers', () => {
  assert.equal(r('{{row.Amount | number:2}}'), '1250.50');
  assert.equal(r('{{row.Amount | number:2:,}}'), '1250,50');
  assert.equal(render('{{x | number:0}}', { x: '1,250.75' }), '1251');
  assert.equal(render('{{x | number}}', { x: '1,250' }), '1250');
});

test('unknown filter is reported, preview never throws', () => {
  assert.throws(() => r('{{row.Name | shout}}'), /unknown format "shout"/);
  assert.deepEqual(preview('{{row.Name | shout}}', vars), { error: 'unknown format "shout"' });
  assert.deepEqual(preview('Hi {{row.Name | title}}', vars), { text: 'Hi Ana Lima' });
});
