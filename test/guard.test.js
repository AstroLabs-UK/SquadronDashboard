const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../lib/settingsGuard');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-guard-'));

test('snapshot then restore brings back wiped settings', () => {
  const data = tmp(), snap = tmp();
  fs.writeFileSync(path.join(data, 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(data, 'edit-pin'), '9999\n');
  assert.equal(guard.snapshot(data, snap).ok, true);
  fs.rmSync(data, { recursive: true });
  assert.equal(guard.restore(data, snap, { onlyMissing: true }), true);
  assert.equal(fs.readFileSync(path.join(data, 'data.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(data, 'edit-pin'), 'utf8'), '9999\n');
});

test('an empty data/ never overwrites a good snapshot', () => {
  const data = tmp(), snap = tmp();
  fs.writeFileSync(path.join(snap, 'data.json'), '{"good":true}');
  assert.equal(guard.snapshot(data, snap).ok, false);
  assert.equal(fs.readFileSync(path.join(snap, 'data.json'), 'utf8'), '{"good":true}');
});

test('onlyMissing restore never overwrites files that exist', () => {
  const data = tmp(), snap = tmp();
  fs.writeFileSync(path.join(snap, 'data.json'), '{"old":true}');
  fs.writeFileSync(path.join(data, 'data.json'), '{"current":true}');
  guard.restore(data, snap, { onlyMissing: true });
  assert.equal(fs.readFileSync(path.join(data, 'data.json'), 'utf8'), '{"current":true}');
});

test('restore does nothing when there is no snapshot', () => {
  assert.equal(guard.restore(tmp(), tmp()), false);
});

test('a backup for an app in a drive/filesystem root goes to the home folder, not the root', () => {
  const saved = process.env.DATA_BACKUP_DIR;
  delete process.env.DATA_BACKUP_DIR;
  try {
    const rootApp = path.parse(os.tmpdir()).root + 'SquadronDashboard';
    assert.equal(guard.defaultSnapshotDir(rootApp), path.join(os.homedir(), 'sqndash-data-backup'));
    const nested = path.join(os.tmpdir(), 'x', 'SquadronDashboard');
    assert.equal(guard.defaultSnapshotDir(nested), path.join(path.dirname(nested), 'sqndash-data-backup'));
  } finally { if (saved !== undefined) process.env.DATA_BACKUP_DIR = saved; }
});
