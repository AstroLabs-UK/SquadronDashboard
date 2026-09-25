const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit, securityHeaders } = require('../lib/security');
const { pinsMatch, readPin } = require('../lib/auth');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null, listeners: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.on = (ev, fn) => { res.listeners[ev] = fn; };
  return res;
}

test('rateLimit lets max requests through, then answers 429 with Retry-After', () => {
  let t = 0;
  const limit = rateLimit({ windowMs: 1000, max: 3, now: () => t });
  const req = { ip: '1.2.3.4' };
  let passed = 0;
  for (let i = 0; i < 3; i++) limit(req, fakeRes(), () => passed++);
  assert.equal(passed, 3);
  const res = fakeRes();
  limit(req, res, () => assert.fail('should be blocked'));
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) >= 1);
  // another client is unaffected, and the window resets
  limit({ ip: '9.9.9.9' }, fakeRes(), () => passed++);
  assert.equal(passed, 4);
  t = 1500;
  limit(req, fakeRes(), () => passed++);
  assert.equal(passed, 5);
});

test('rateLimit with skipSuccessful only counts failed responses', () => {
  const limit = rateLimit({ windowMs: 1000, max: 2, skipSuccessful: true });
  const req = { ip: 'a' };
  const finish = code => { const r = fakeRes(); limit(req, r, () => {}); r.statusCode = code; r.listeners.finish(); };
  finish(200); finish(200); finish(200);          // successes never count
  finish(401); finish(401);                        // two failures reach the limit
  const res = fakeRes();
  limit(req, res, () => assert.fail('should be locked out'));
  assert.equal(res.statusCode, 429);
});

test('security headers are set', () => {
  const res = fakeRes(); let called = false;
  securityHeaders({}, res, () => { called = true; });
  assert.ok(called);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'SAMEORIGIN');
});

test('pinsMatch is exact', () => {
  assert.ok(pinsMatch('1234', '1234'));
  assert.ok(!pinsMatch('1235', '1234'));
  assert.ok(!pinsMatch('', '1234'));
  assert.ok(!pinsMatch('12345', '1234'));
});

test('readPin: env var wins over the data/edit-pin file; blank when neither', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-pin-'));
  const saved = process.env.EDIT_PIN;
  delete process.env.EDIT_PIN;
  try {
    assert.equal(readPin(dir), '');
    fs.writeFileSync(path.join(dir, 'edit-pin'), '  4321\n');
    assert.equal(readPin(dir), '4321');
    process.env.EDIT_PIN = 'fromenv';
    assert.equal(readPin(dir), 'fromenv');
    process.env.EDIT_PIN = '';   // docker-compose passes an empty value when unset
    assert.equal(readPin(dir), '4321');
  } finally {
    if (saved === undefined) delete process.env.EDIT_PIN; else process.env.EDIT_PIN = saved;
  }
});
