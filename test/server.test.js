// End-to-end checks against the real app on a random port: editor PIN, headers, health.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-srv-'));
process.env.DATA_DIR = dataDir;
process.env.AUTO_UPDATE = '0';
process.env.DATA_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-snap-'));
delete process.env.EDIT_PIN;

const app = require('../server');
let server, base;
const basic = pin => ({ Authorization: 'Basic ' + Buffer.from(':' + pin).toString('base64') });
const postJson = (url, body, headers = {}) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('/healthz answers and responses carry security headers', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('with no PIN set the editor stays open (upgrades never lock anyone out)', async () => {
  assert.equal((await fetch(base + '/edit')).status, 200);
  const r = await postJson('/api/data', { squadronName: 'Open Squadron' });
  assert.equal(r.status, 200);
});

test('with a PIN set: /edit, saving and force-update need it; the display stays open', async () => {
  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '2468\n');

  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/api/data')).status, 200);
  assert.equal((await fetch(base + '/status')).status, 200);

  const noAuth = await fetch(base + '/edit');
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') || '', /Basic/);
  assert.equal((await fetch(base + '/edit', { headers: basic('0000') })).status, 401);
  assert.equal((await fetch(base + '/edit', { headers: basic('2468') })).status, 200);

  assert.equal((await postJson('/api/data', { squadronName: 'Hacked' })).status, 401);
  assert.equal((await postJson('/api/update', {})).status, 401);
  const ok = await postJson('/api/data', { squadronName: 'Real Squadron' }, basic('2468'));
  assert.equal(ok.status, 200);
  assert.equal((await (await fetch(base + '/api/data')).json()).squadronName, 'Real Squadron');
});

test('bad settings are rejected by validation, not stored', async () => {
  const r = await postJson('/api/data', { leaderboardCsvUrl: 'javascript:alert(1)' }, basic('2468'));
  assert.equal((await r.json()).data.leaderboardCsvUrl, '');
});

test('changing data/edit-pin takes effect immediately', async () => {
  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '1357\n');
  assert.equal((await fetch(base + '/edit', { headers: basic('2468') })).status, 401);
  assert.equal((await fetch(base + '/edit', { headers: basic('1357') })).status, 200);
});

test('/api/status reports whether a PIN is set', async () => {
  const s = await (await fetch(base + '/api/status')).json();
  assert.equal(s.editorPin, 'ONLINE');
  assert.equal(s.serverStatus, 'ONLINE');
});

test('repeated wrong PINs are locked out (last, because it changes limiter state)', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await fetch(base + '/edit', { headers: basic('bad' + i) });
  assert.equal(last.status, 429);
  // even the right PIN is refused during the lockout
  assert.equal((await fetch(base + '/edit', { headers: basic('1357') })).status, 429);
});
