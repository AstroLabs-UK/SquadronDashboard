#!/usr/bin/env node
// Command-line front end to the update engine (used by sqndash.ps1 on Windows).
//   node scripts/update.js --check     compare this copy with the update target
//   node scripts/update.js --update    update if there is a newer version
//   node scripts/update.js --force     re-apply the target even if already on it
// Exit codes:  0 = up to date / nothing to do   10 = updated (restart needed)
//              11 = behind (--check only)       20 = new version failed its safety check, rolled back
//              1 = could not reach GitHub       3 = not a git checkout / no target
const path = require('path');
const fs = require('fs');
const { git, firstWord } = require('../lib/git');
const release = require('../lib/release');
const { checkAndUpdate } = require('../autoUpdate');

const cwd = path.join(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(cwd, 'data');

async function check() {
  if (!fs.existsSync(path.join(cwd, '.git'))) { console.log('Not a git repository: ' + cwd); return 3; }
  console.log('Fetching from GitHub...');
  if (!(await release.fetchRemote(cwd))) { console.log('Could not reach GitHub'); return 1; }
  const target = await release.resolveTarget({ cwd, dataDir });
  const localSha = firstWord((await git(['rev-parse', 'HEAD'], { cwd })).out);
  const localShort = firstWord((await git(['rev-parse', '--short', 'HEAD'], { cwd })).out);
  const localMsg = (await git(['log', '-1', '--pretty=%s'], { cwd })).out;
  console.log('Local:   ' + localShort + '  ' + localMsg);
  if (!target) { console.log('Target:  (no release tag or origin/main found)'); return 3; }
  console.log('Target:  ' + target.short + '  ' + target.message + '  (' + target.label + ', ' + target.channel + ' channel)');
  if (localSha === target.sha) { console.log('Status: up to date'); return 0; }
  if (await release.isAncestor(cwd, target.sha, localSha)) { console.log('Status: this copy is newer than the target - nothing to update'); return 0; }
  const behind = (await git(['rev-list', '--count', 'HEAD..' + target.sha], { cwd })).out || '?';
  console.log('Status: behind by ' + behind + ' commit(s)');
  return 11;
}

async function update(force) {
  const r = await checkAndUpdate({ cwd, dataDir, force });
  console.log('[update] ' + (r.label ? r.label + ': ' : '') + r.reason);
  if (r.updated) return 10;
  if (r.rolledBack) return 20;
  if (r.reason === 'fetch failed') return 1;
  if (r.reason === 'not a git repository' || r.reason === 'no remote ref') return 3;
  return 0;
}

(async () => {
  const arg = process.argv[2] || '--check';
  let code;
  if (arg === '--check') code = await check();
  else if (arg === '--update') code = await update(false);
  else if (arg === '--force') code = await update(true);
  else { console.log('usage: node scripts/update.js --check | --update | --force'); code = 2; }
  process.exit(code);
})().catch(e => { console.error(e); process.exit(1); });
