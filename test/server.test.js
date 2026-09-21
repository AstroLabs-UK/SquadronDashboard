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

async function login(pin) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  // node fetch may expose getSetCookie(); fall back to raw header
  let cookie = '';
  if (setCookie && setCookie.length) {
    cookie = setCookie.map(c => c.split(';')[0]).join('; ');
  } else {
    const raw = r.headers.get('set-cookie');
    if (raw) cookie = raw.split(',').map(c => c.split(';')[0].trim()).join('; ');
  }
  return { res: r, cookie, body: await r.json().catch(() => ({})) };
}

const postJson = (url, body, cookie = '') => fetch(base + url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {})
  },
  body: JSON.stringify(body)
});

const get = (url, cookie = '') => fetch(base + url, {
  headers: cookie ? { Cookie: cookie } : {},
  redirect: 'manual'
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

test('with a PIN set: /edit redirects to /pin; login cookie unlocks editor', async () => {
  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '2468\n');

  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/api/data')).status, 200);
  assert.equal((await fetch(base + '/status')).status, 200);
  assert.equal((await fetch(base + '/pin')).status, 200);

  // Unauthenticated page request is redirected to the stylised PIN screen
  const noAuth = await get('/edit');
  assert.ok([302, 401].includes(noAuth.status));
  if (noAuth.status === 302) {
    assert.match(noAuth.headers.get('location') || '', /\/pin/);
  }

  // Wrong PIN rejected
  const bad = await login('0000');
  assert.equal(bad.res.status, 401);
  assert.equal(bad.body.ok, false);

  // Correct PIN sets cookie
  const good = await login('2468');
  assert.equal(good.res.status, 200);
  assert.equal(good.body.ok, true);
  assert.ok(good.cookie, 'expected session cookie');

  // Cookie unlocks /edit and POST /api/data
  assert.equal((await get('/edit', good.cookie)).status, 200);
  assert.equal((await postJson('/api/data', { squadronName: 'Hacked' })).status, 401);
  const ok = await postJson('/api/data', { squadronName: 'Real Squadron' }, good.cookie);
  assert.equal(ok.status, 200);
  assert.equal((await (await fetch(base + '/api/data')).json()).squadronName, 'Real Squadron');
});

test('bad settings are rejected by validation, not stored', async () => {
  const { cookie } = await login('2468');
  const r = await postJson('/api/data', { leaderboardCsvUrl: 'javascript:alert(1)' }, cookie);
  assert.equal((await r.json()).data.leaderboardCsvUrl, '');
});

test('changing data/edit-pin takes effect immediately (old sessions die)', async () => {
  const old = await login('2468');
  assert.equal(old.res.status, 200);
  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '1357\n');
  // Cookie signed against the old PIN is now invalid
  assert.ok([302, 401].includes((await get('/edit', old.cookie)).status));
  const neu = await login('1357');
  assert.equal(neu.res.status, 200);
  assert.equal((await get('/edit', neu.cookie)).status, 200);
});

test('/api/status reports whether a PIN is set', async () => {
  const s = await (await fetch(base + '/api/status')).json();
  assert.equal(s.editorPin, 'ONLINE');
  assert.equal(s.serverStatus, 'ONLINE');
});

test('repeated wrong PINs are locked out (last, because it changes limiter state)', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await login('bad' + i);
  assert.equal(last.res.status, 429);
  // even the right PIN is refused during the lockout
  const blocked = await login('1357');
  assert.equal(blocked.res.status, 429);
});
