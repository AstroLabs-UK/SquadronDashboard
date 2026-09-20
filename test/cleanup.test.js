const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeTempFiles } = require('../lib/cleanup');

const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };

test('deletes files named exactly "temp" at any depth, and only those', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-clean-'));
  ['temp', 'a/temp', 'a/b/temp', 'public/temp'].forEach(f => touch(path.join(root, f)));
  ['temp.txt', 'template.js', 'a/Temp', 'a/b/mytemp', 'server.js'].forEach(f => touch(path.join(root, f)));
  assert.equal(removeTempFiles(root), 4);
  for (const f of ['temp', 'a/temp', 'a/b/temp', 'public/temp']) assert.equal(fs.existsSync(path.join(root, f)), false, f);
  for (const f of ['temp.txt', 'template.js', 'a/Temp', 'a/b/mytemp', 'server.js']) assert.equal(fs.existsSync(path.join(root, f)), true, f);
});

test('leaves node_modules, .git and data/ alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-clean-'));
  const keep = ['node_modules/pkg/temp', '.git/temp', 'data/temp'];
  keep.forEach(f => touch(path.join(root, f)));
  assert.equal(removeTempFiles(root), 0);
  keep.forEach(f => assert.equal(fs.existsSync(path.join(root, f)), true, f));
});

test('a folder called temp is kept (only files are deleted), but a temp file inside it goes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-clean-'));
  touch(path.join(root, 'temp', 'temp'));
  touch(path.join(root, 'temp', 'keep.js'));
  assert.equal(removeTempFiles(root), 1);
  assert.equal(fs.existsSync(path.join(root, 'temp', 'keep.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'temp', 'temp')), false);
});

test('is silent: prints nothing, and a missing folder is not an error', () => {
  const writes = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => writes.push(a);
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-clean-'));
    touch(path.join(root, 'temp'));
    removeTempFiles(root);
    assert.equal(removeTempFiles(path.join(root, 'does-not-exist')), 0);
  } finally { Object.assign(console, orig); }
  assert.deepEqual(writes, []);
});
