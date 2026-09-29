const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const qrCache = require('../lib/qrCache');

test('keyFrom is stable and safe', () => {
  const a = qrCache.keyFrom('https://example.com/x', 72);
  const b = qrCache.keyFrom('https://example.com/x', 72);
  assert.equal(a, b);
  assert.match(a, qrCache.KEY_RE);
});

test('put and get PNG round-trip; clear empties folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-qr-'));
  const key = qrCache.keyFrom('https://example.com', 64);
  // minimal PNG header + payload (not a full valid image, but magic bytes checked)
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0, 0, 0, 0, 0
  ]);
  assert.equal(qrCache.putPng(dir, key, png), true);
  const got = qrCache.getPng(dir, key);
  assert.ok(got);
  assert.equal(got.length, png.length);
  assert.ok(qrCache.clearAll(dir) >= 1);
  assert.equal(qrCache.getPng(dir, key), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects path-like keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-qr-'));
  assert.equal(qrCache.putPng(dir, '../etc/passwd', Buffer.from([0x89, 0x50, 0, 0, 0, 0, 0, 0])), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
