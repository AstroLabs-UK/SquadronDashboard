// Exercises the update engine against throw-away local git repos (no network):
// release-tag targeting, no-downgrade, the canary safety check and rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkAndUpdate } = require('../autoUpdate');
const release = require('../lib/release');

const GOOD = v => `// ${v}\nrequire('http').createServer((q, r) => r.end('{"ok":true}')).listen(process.env.PORT, process.env.HOST);\n`;
const BROKEN = `throw new Error('boom - broken release');\n`;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

// origin (bare) + a "developer" clone to publish from + a "device" clone that updates
function makeWorld({ tag = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-world-'));
  const origin = path.join(root, 'origin.git');
  const dev = path.join(root, 'dev');
  const device = path.join(root, 'device');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, dev);
  fs.writeFileSync(path.join(dev, 'server.js'), GOOD('v1.0.0'));
  fs.writeFileSync(path.join(dev, '.gitignore'), 'data/\n');
  git(dev, 'add', '-A'); git(dev, 'commit', '-m', 'v1.0.0');
  if (tag) git(dev, 'tag', 'v1.0.0');
  git(dev, 'push', 'origin', 'main', '--tags');
  git(root, 'clone', origin, device);
  const publish = (version, { broken = false, doTag = true } = {}) => {
    fs.writeFileSync(path.join(dev, 'server.js'), broken ? BROKEN : GOOD(version));
    git(dev, 'commit', '-am', version);
    if (doTag) git(dev, 'tag', version);
    git(dev, 'push', 'origin', 'main', '--tags');
  };
  return { root, dev, device, dataDir: path.join(device, 'data'), publish };
}
const head = cwd => git(cwd, 'rev-parse', 'HEAD');
const tagSha = (cwd, t) => git(cwd, 'rev-parse', t + '^{commit}');
const readStatus = dir => JSON.parse(fs.readFileSync(path.join(dir, 'update-status.json'), 'utf8'));

test('pickLatestTag sorts numerically and ignores pre-release tags', () => {
  assert.equal(release.pickLatestTag(['v1.9.0', 'v1.10.0', 'v1.2.0', 'v2.0.0-beta', 'latest']), 'v1.10.0');
  assert.equal(release.pickLatestTag(['nightly']), null);
});

test('release channel: updates to the newest tag, NOT to untagged commits on main', async () => {
  const w = makeWorld();
  w.publish('v1.1.0');
  w.publish('work-in-progress', { doTag: false });
  const r = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(r.updated, true, JSON.stringify(r));
  assert.equal(head(w.device), tagSha(w.device, 'v1.1.0'));
  assert.equal(readStatus(w.dataDir).state, 'done');
  // and now it is up to date
  assert.equal((await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir })).reason, 'up to date');
});

test('a copy that is already ahead of the target is never downgraded', async () => {
  const w = makeWorld();
  w.publish('newer-untagged', { doTag: false });
  git(w.device, 'pull', '--quiet', 'origin', 'main');
  const before = head(w.device);
  const r = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(r.updated, false);
  assert.equal(r.reason, 'ahead of target');
  assert.equal(head(w.device), before);
});

test('main channel follows the tip of main', async () => {
  const w = makeWorld();
  w.publish('tip', { doTag: false });
  process.env.UPDATE_CHANNEL = 'main';
  try {
    const r = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
    assert.equal(r.updated, true, JSON.stringify(r));
    assert.equal(head(w.device), git(w.dev, 'rev-parse', 'HEAD'));
  } finally { delete process.env.UPDATE_CHANNEL; }
});

test('the channel can also be set with data/update-channel', async () => {
  const w = makeWorld();
  fs.mkdirSync(w.dataDir, { recursive: true });
  fs.writeFileSync(path.join(w.dataDir, 'update-channel'), 'main\n');
  assert.equal(release.readChannel(w.dataDir), 'main');
  fs.writeFileSync(path.join(w.dataDir, 'update-channel'), 'nonsense\n');
  assert.equal(release.readChannel(w.dataDir), 'release');
});

test('no release tags yet: falls back to main so devices are not stranded', async () => {
  const w = makeWorld({ tag: false });
  w.publish('next', { doTag: false });
  const r = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(r.updated, true, JSON.stringify(r));
  assert.match(r.label, /no release tags yet/);
});

test('a broken release fails the canary, is rolled back, and is not retried', async () => {
  const w = makeWorld();
  w.publish('v1.1.0');
  await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  const good = head(w.device);

  w.publish('v1.2.0', { broken: true });
  const r = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(r.updated, false);
  assert.equal(r.rolledBack, true, JSON.stringify(r));
  assert.equal(head(w.device), good, 'device must be back on the last good version');
  assert.match(fs.readFileSync(path.join(w.device, 'server.js'), 'utf8'), /v1\.1\.0/);
  assert.equal(readStatus(w.dataDir).state, 'error');
  assert.equal(release.readSkip(w.dataDir), tagSha(w.device, 'v1.2.0'));

  // next automatic check skips the known-bad release instead of trying it again
  const again = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(again.updated, false);
  assert.match(again.reason, /skipping/);
  assert.equal(head(w.device), good);

  // once a fixed release is tagged, the device moves on
  w.publish('v1.2.1');
  const fixed = await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(fixed.updated, true, JSON.stringify(fixed));
});

test('settings in data/ survive an update and a rollback', async () => {
  const w = makeWorld();
  fs.mkdirSync(w.dataDir, { recursive: true });
  fs.writeFileSync(path.join(w.dataDir, 'data.json'), '{"squadronName":"Keep me"}');
  w.publish('v1.1.0');
  await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  w.publish('v1.2.0', { broken: true });
  await checkAndUpdate({ cwd: w.device, dataDir: w.dataDir });
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'data.json'), 'utf8'), '{"squadronName":"Keep me"}');
});
