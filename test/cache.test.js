const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('../lib/cache');

test('fresh values are served without calling the loader again', async () => {
  let t = 0, calls = 0;
  const c = createCache({ ttlMs: 1000, now: () => t });
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
  const c = createCache({ ttlMs: 1000, staleMs: 10000, now: () => t });
  await c.get('k', async () => 'good');
  t = 2000;
  const r = await c.get('k', async () => { throw new Error('offline'); });
  assert.equal(r.value, 'good');
  assert.equal(r.stale, true);
});

test('too-old stale values are not served, and errors are never cached', async () => {
  let t = 0;
  const c = createCache({ ttlMs: 1000, staleMs: 5000, now: () => t });
  await c.get('k', async () => 'good');
  t = 6000;
  await assert.rejects(c.get('k', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(c.get('never', async () => { throw new Error('boom'); }), /boom/);
  assert.equal((await c.get('never', async () => 'ok')).value, 'ok');
});

test('simultaneous requests share one upstream call', async () => {
  let calls = 0;
  const c = createCache({ ttlMs: 1000 });
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return 'x'; };
  await Promise.all([c.get('k', slow), c.get('k', slow), c.get('k', slow)]);
  assert.equal(calls, 1);
});
