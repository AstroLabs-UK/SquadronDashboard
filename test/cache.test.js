const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCache, getRegisteredStats } = require('../lib/cache');
const { withRetries } = require('../lib/upstream');

test('fresh values are served without calling the loader again', async () => {
  let t = 0, calls = 0;
  const c = createCache({ ttlMs: 1000, now: () => t, log: false });
  const load = async () => { calls++; return 'v' + calls; };
  assert.equal((await c.get('k', load)).value, 'v1');
  t = 500;
  assert.equal((await c.get('k', load)).value, 'v1');
  assert.equal(calls, 1);
  t = 1500;
  assert.equal((await c.get('k', load)).value, 'v2');
});

test('when the upstream fails the last good value is served, marked stale', async () => {
  let t = 0;
  const c = createCache({ ttlMs: 1000, staleMs: 10000, cooldownMs: 0, now: () => t, log: false });
  await c.get('k', async () => 'good');
  t = 2000;
  const r = await c.get('k', async () => { throw new Error('offline'); });
  assert.equal(r.value, 'good');
  assert.equal(r.stale, true);
});

test('too-old stale values are not served, and errors are never cached', async () => {
  let t = 0;
  const c = createCache({ ttlMs: 1000, staleMs: 5000, cooldownMs: 0, now: () => t, log: false });
  await c.get('k', async () => 'good');
  t = 6000;
  await assert.rejects(c.get('k', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(c.get('never', async () => { throw new Error('boom'); }), /boom/);
  assert.equal((await c.get('never', async () => 'ok')).value, 'ok');
});

test('simultaneous requests share one upstream call', async () => {
  let calls = 0;
  const c = createCache({ ttlMs: 1000, log: false });
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return 'x'; };
  await Promise.all([c.get('k', slow), c.get('k', slow), c.get('k', slow)]);
  assert.equal(calls, 1);
});

test('disk persistence restores last-good value after a new cache is created', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-cache-'));
  const persistPath = path.join(dir, 'weather.json');
  let t = 1000;
  const c1 = createCache({ ttlMs: 100, staleMs: 999999, now: () => t, persistPath, service: 'test-disk', log: false });
  await c1.get('k', async () => ({ temp: 12 }));
  assert.ok(fs.existsSync(persistPath));
  // New process-style cache
  t = 5000;
  const c2 = createCache({ ttlMs: 100, staleMs: 999999, cooldownMs: 0, now: () => t, persistPath, service: 'test-disk-2', log: false });
  const r = await c2.get('k', async () => { throw new Error('offline'); });
  assert.equal(r.value.temp, 12);
  assert.equal(r.stale, true);
});

test('cooldown avoids hammering upstream when stale data exists', async () => {
  let t = 0, calls = 0;
  const c = createCache({ ttlMs: 100, staleMs: 60000, cooldownMs: 5000, now: () => t, log: false });
  await c.get('k', async () => { calls++; return 'ok'; });
  // Past TTL: first failure still returns stale (last good within staleMs)
  t = 200;
  const first = await c.get('k', async () => { calls++; throw new Error('down'); });
  assert.equal(first.stale, true);
  assert.equal(first.value, 'ok');
  const afterFail = calls;
  // Within cooldown — should not call loader again
  t = 500;
  const r = await c.get('k', async () => { calls++; throw new Error('down'); });
  assert.equal(r.stale, true);
  assert.equal(calls, afterFail);
});

test('withRetries eventually succeeds after transient failures', async () => {
  let n = 0;
  const v = await withRetries(async () => {
    n++;
    if (n < 3) throw new Error('temp');
    return 'yes';
  }, { retries: 3, delaysMs: [1, 1, 1], label: 't' });
  assert.equal(v, 'yes');
  assert.equal(n, 3);
});

test('withRetries gives up after max attempts', async () => {
  let n = 0;
  await assert.rejects(withRetries(async () => {
    n++;
    throw new Error('always');
  }, { retries: 2, delaysMs: [1, 1], label: 't' }), /always/);
  assert.equal(n, 3);
});

test('registered cache stats are available', async () => {
  const c = createCache({ ttlMs: 1000, service: 'stats-probe', log: false });
  await c.get('k', async () => 1);
  const all = getRegisteredStats();
  assert.ok(all['stats-probe']);
  assert.equal(all['stats-probe'].hasCache, true);
});
