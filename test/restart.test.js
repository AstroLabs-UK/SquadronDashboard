const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnReplacement } = require('../lib/restart');

test('the replacement starts after the delay, even from a folder with spaces in its name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn restart '));
  const marker = path.join(dir, 'started.txt');
  const script = path.join(dir, 'fake server.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'up:' + (process.env.SQN_RESTART === undefined));`);
  spawnReplacement({ cwd: dir, args: [script], delayMs: 300 });
  assert.equal(fs.existsSync(marker), false, 'must not start immediately');
  for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'up:true', 'replacement should run, without the helper variable leaking into it');
});
