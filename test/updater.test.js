const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requestUpdate, getStatus } = require('../updater');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-upd-'));

test('first request is accepted, a second is refused while pending', () => {
  const dir = tmp();
  assert.equal(requestUpdate(dir).ok, true);
  const again = requestUpdate(dir);
  assert.equal(again.ok, false);
  assert.equal(again.code, 409);
  assert.equal(getStatus(dir).state, 'requested');
});

test('a request nobody picked up for 5+ minutes is treated as stale', () => {
  const dir = tmp();
  const t0 = Date.now();
  assert.equal(requestUpdate(dir, t0).ok, true);
  assert.equal(requestUpdate(dir, t0 + 6 * 60 * 1000).ok, true);
});

test('an update that is still running blocks a new request; a dead one does not', () => {
  const dir = tmp();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'update-status.json'), JSON.stringify({ state: 'running', message: 'x', time: Math.floor(now / 1000) - 60 }));
  assert.equal(requestUpdate(dir, now).ok, false);
  fs.writeFileSync(path.join(dir, 'update-status.json'), JSON.stringify({ state: 'running', message: 'x', time: Math.floor(now / 1000) - 3600 }));
  assert.equal(requestUpdate(dir, now).ok, true);
});

test('status is idle when nothing has happened', () => {
  assert.deepEqual(getStatus(tmp()), { state: 'idle' });
});
