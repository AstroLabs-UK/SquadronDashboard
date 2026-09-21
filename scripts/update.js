#!/usr/bin/env node
// Command-line front end to the update engine (used by sqndash.ps1 on Windows).
//   node scripts/update.js --check     compare this copy with the update target
//   node scripts/update.js --update    update if there is a newer version
//   node scripts/update.js --force     re-apply the target even if already on it
// Exit codes:  0 = up to date / nothing to do   10 = updated (restart needed)
//              11 = behind (--check only)       20 = new version failed its safety check, rolled back
//              1 = could not reach GitHub       3 = not a git checkout / no target
//              4 = could not switch files (git reset failed)   5 = could not read the local commit
const path = require('path');
const fs = require('fs');
const { git, firstWord } = require('../lib/git');
const release = require('../lib/release');
const { checkAndUpdate } = require('../autoUpdate');

const cwd = path.join(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(cwd, 'data');

// Written synchronously: on Windows, process.exit() can cut off buffered output when stdout is a
// pipe (which is what PowerShell uses inside a function), and the result line went missing.
function say(msg) {
  try { fs.writeSync(1, msg + '\n'); } catch (e) { console.log(msg); }
}

function codeForResult(r) {
  if (r.updated) return 10;
  if (r.rolledBack) return 20;
  switch (r.reason) {
    case 'fetch failed': return 1;
    case 'not a git repository':
    case 'no remote ref': return 3;
    case 'reset failed': return 4;
    case 'no local HEAD': return 5;
    default: return 0;
  }
}

async function check() {
  if (!fs.existsSync(path.join(cwd, '.git'))) { say('Not a git repository: ' + cwd); return 3; }
  say('Fetching from GitHub...');
  if (!(await release.fetchRemote(cwd))) { say('Could not reach GitHub'); return 1; }
  const target = await release.resolveTarget({ cwd, dataDir });
  const localSha = firstWord((await git(['rev-parse', 'HEAD'], { cwd })).out);
  const localShort = firstWord((await git(['rev-parse', '--short', 'HEAD'], { cwd })).out);
  const localMsg = (await git(['log', '-1', '--pretty=%s'], { cwd })).out;
  say('Local:   ' + localShort + '  ' + localMsg);
  if (!target) { say('Target:  (no release tag or origin/main found)'); return 3; }
  say('Target:  ' + target.short + '  ' + target.message + '  (' + target.label + ', ' + target.channel + ' channel)');
  if (localSha === target.sha) { say('Status: up to date'); return 0; }
  if (await release.isAncestor(cwd, target.sha, localSha)) { say('Status: this copy is newer than the target - nothing to update'); return 0; }
  const behind = (await git(['rev-list', '--count', 'HEAD..' + target.sha], { cwd })).out || '?';
  say('Status: behind by ' + behind + ' commit(s)');
  return 11;
}

async function update(force) {
  say(force ? 'Forcing an update...' : 'Checking for an update...');
  const r = await checkAndUpdate({ cwd, dataDir, force });
  say('[update] ' + (r.label ? r.label + ': ' : '') + r.reason + (r.detail ? ' - ' + r.detail : ''));
  return codeForResult(r);
}

if (require.main === module) {
  (async () => {
    const arg = process.argv[2] || '--check';
    let code;
    if (arg === '--check') code = await check();
    else if (arg === '--update') code = await update(false);
    else if (arg === '--force') code = await update(true);
    else { say('usage: node scripts/update.js --check | --update | --force'); code = 2; }
    process.exitCode = code;
    setTimeout(() => process.exit(code), 300); // output is already written; don't hang on stray handles
  })().catch(e => {
    say('[update] crashed: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 300);
  });
}

module.exports = { codeForResult };
