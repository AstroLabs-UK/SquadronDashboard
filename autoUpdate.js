// In-process update engine, used by:
//   - the automatic update check on hosts that run Node directly (Windows / bare Node)
//   - the "Force update" button on /edit (when not managed by systemd/Docker)
//   - scripts/update.js, which sqndash.ps1 calls on Windows
//
// What it does, in order:
//   1. Fetch from GitHub and work out the target version (see lib/release.js - by default
//      the newest release tag, not the tip of main).
//   2. Never downgrade a device that is already at or ahead of the target (unless forced).
//   3. Reset to the target, and only run `npm install` if package.json actually changed.
//   4. CANARY: start a throw-away copy of the new code and wait for it to answer /healthz.
//   5. If that fails, roll back to the previous version, remember the bad release so it
//      isn't retried every few minutes, and leave the running dashboard untouched.
// Settings in data/ are git-ignored and are never touched.
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { spawnReplacement } = require('./lib/restart');
const { git, firstWord } = require('./lib/git');
const release = require('./lib/release');
const { runCanary } = require('./lib/canary');
const guard = require('./lib/settingsGuard');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function run(cmd, opts = {}) {
  return new Promise(resolve => {
    exec(cmd, {
      cwd: opts.cwd,
      timeout: opts.timeout || 60000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) }
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, out: (stdout || '').trim(), err: (stderr || '').trim() });
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// `git reset --hard` can fail on Windows for a moment (a file briefly locked by antivirus or an
// editor) or because a crashed git left .git/index.lock behind. Clear a stale lock and try once more.
async function resetHard(cwd, sha) {
  let r = await git(['reset', '--hard', sha], { cwd, timeout: 30000 });
  if (r.ok) return r;
  try {
    const lock = path.join(cwd, '.git', 'index.lock');
    if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock);
  } catch (e) { /* no lock */ }
  await sleep(1500);
  r = await git(['reset', '--hard', sha], { cwd, timeout: 30000 });
  return r;
}

function writeStatus(dataDir, state, message) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const payload = JSON.stringify({
      state,
      message: String(message || '').slice(0, 500),
      time: Math.floor(Date.now() / 1000)
    });
    const file = path.join(dataDir, 'update-status.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch (e) { /* best effort */ }
}

// systemd (INVOCATION_ID) or Docker (/.dockerenv) already supervises the process and the Pi's
// own update timer handles updates - a second, in-process updater would fight it, and
// re-spawning a detached process outside systemd's control gets it killed.
function isSupervised() {
  return !!process.env.INVOCATION_ID || fs.existsSync('/.dockerenv');
}

async function npmInstallIfNeeded(cwd, depsChanged) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return { ok: true, skipped: true };
  if (!depsChanged && fs.existsSync(path.join(cwd, 'node_modules'))) return { ok: true, skipped: true };
  return run('npm install --omit=dev', { cwd, timeout: 180000 });
}

/**
 * @returns {Promise<{ updated: boolean, reason: string, rolledBack?: boolean, local?: string,
 *                     remote?: string, short?: string, label?: string }>}
 */
async function checkAndUpdate({ cwd, dataDir, force = false, canary = runCanary, snapDir = guard.defaultSnapshotDir(cwd) }) {
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    return { updated: false, reason: 'not a git repository' };
  }
  writeStatus(dataDir, 'running', 'Checking GitHub for updates…');

  if (!(await release.fetchRemote(cwd))) {
    writeStatus(dataDir, 'error', 'Could not reach GitHub');
    return { updated: false, reason: 'fetch failed' };
  }

  const localSha = firstWord((await git(['rev-parse', 'HEAD'], { cwd })).out);
  if (!localSha) {
    writeStatus(dataDir, 'error', 'Could not read local commit');
    return { updated: false, reason: 'no local HEAD' };
  }

  const target = await release.resolveTarget({ cwd, dataDir });
  if (!target) {
    writeStatus(dataDir, 'error', 'No release tag or origin/main found on GitHub');
    return { updated: false, reason: 'no remote ref' };
  }

  const localShort = firstWord((await git(['rev-parse', '--short', 'HEAD'], { cwd })).out) || localSha.slice(0, 7);

  if (!force) {
    if (localSha === target.sha) {
      writeStatus(dataDir, 'done', 'Already on the latest version (' + localShort + ', ' + target.label + ')');
      return { updated: false, reason: 'up to date', local: localSha, remote: target.sha };
    }
    // Never downgrade: this copy already contains everything in the target (e.g. a dev checkout ahead of the last release)
    if (await release.isAncestor(cwd, target.sha, localSha)) {
      writeStatus(dataDir, 'done', 'Already on the latest version (' + localShort + ' is newer than ' + target.label + ')');
      return { updated: false, reason: 'ahead of target', local: localSha, remote: target.sha };
    }
    if (release.readSkip(dataDir) === target.sha) {
      writeStatus(dataDir, 'error', 'Skipping ' + target.label + ' (' + target.short + ') - it failed its safety check earlier');
      return { updated: false, reason: 'skipping release that failed earlier', local: localSha, remote: target.sha };
    }
  }

  writeStatus(dataDir, 'running', 'Downloading ' + target.label + '…');
  const depsChanged = await release.dependenciesChanged(cwd, localSha, target.sha);

  // Settings are snapshotted outside the app folder and put back after every code swap, so
  // they survive even a release with a broken/missing .gitignore (see lib/settingsGuard.js)
  const snapped = guard.snapshot(dataDir, snapDir);
  const reset = await resetHard(cwd, target.sha);
  if (!reset.ok) {
    if (snapped) guard.restore(dataDir, snapDir);
    const detail = (reset.err || reset.out || 'unknown').split('\n').slice(0, 3).join(' ');
    writeStatus(dataDir, 'error', 'git reset failed: ' + detail);
    return { updated: false, reason: 'reset failed', detail };
  }
  await git(['clean', '-fd', ...guard.CLEAN_KEEP], { cwd, timeout: 15000 });
  if (snapped) guard.restore(dataDir, snapDir);

  const inst = await npmInstallIfNeeded(cwd, depsChanged);
  writeStatus(dataDir, 'running', 'Testing ' + target.label + ' before switching to it…');
  const check = inst.ok ? await canary({ cwd, dataDir }) : { ok: false, reason: 'npm install failed' };

  if (!check.ok) {
    // Roll back so the running dashboard (and the next restart) keep using the last good version
    await resetHard(cwd, localSha);
    await git(['clean', '-fd', ...guard.CLEAN_KEEP], { cwd, timeout: 15000 });
    if (snapped) guard.restore(dataDir, snapDir);
    if (depsChanged) await npmInstallIfNeeded(cwd, true);
    release.writeSkip(dataDir, target.sha, check.reason);
    writeStatus(dataDir, 'error',
      target.label + ' failed its safety check (' + check.reason + ') - rolled back to ' + localShort);
    return { updated: false, rolledBack: true, reason: 'rolled back: ' + check.reason, local: localSha, remote: target.sha, label: target.label };
  }

  writeStatus(dataDir, 'done', 'Updated to ' + target.label + ' (' + target.short + ') — restarting');
  return { updated: true, reason: 'updated', local: localSha, remote: target.sha, short: target.short, label: target.label };
}

function restartProcess(cwd) {
  // Launch the replacement first (it waits ~2 s for this process to release the port), then exit.
  // If it can't even be launched, stay running rather than leave the dashboard stopped.
  try {
    spawnReplacement({ cwd });
  } catch (e) {
    console.error('[auto-update] could not start the replacement process - staying on the current one', e);
    writeStatus(process.env.DATA_DIR || path.join(cwd, 'data'), 'error', 'Updated, but the restart failed - restart the dashboard manually');
    return;
  }
  process.exit(0);
}

function startAutoUpdate({ cwd, dataDir, intervalMs }) {
  const flag = (process.env.AUTO_UPDATE || '').toLowerCase();
  if (flag === '0' || flag === 'false') {
    console.log('[auto-update] disabled (AUTO_UPDATE=0)');
    return;
  }
  if (isSupervised() && flag !== '1' && flag !== 'true') {
    console.log('[auto-update] skipped - running under systemd/Docker, where the host update timer does this');
    return;
  }
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    console.log('[auto-update] skipped — no .git folder (e.g. Docker image without git history)');
    return;
  }

  const ms = intervalMs || parseInt(process.env.AUTO_UPDATE_MS || '', 10) || DEFAULT_INTERVAL_MS;
  let busy = false;

  async function tick(label) {
    if (busy) return;
    busy = true;
    try {
      console.log('[auto-update] ' + label + '…');
      const result = await checkAndUpdate({ cwd, dataDir, force: false });
      if (result.updated) {
        console.log('[auto-update] applied ' + (result.short || result.remote) + ' — restarting process');
        restartProcess(cwd);
        return;
      }
      console.log('[auto-update] ' + result.reason);
    } catch (e) {
      console.error('[auto-update] error', e);
      writeStatus(dataDir, 'error', String(e && e.message ? e.message : e));
    } finally {
      busy = false;
    }
  }

  setTimeout(() => tick('check at launch'), 8000);
  setInterval(() => tick('scheduled check'), ms);
  console.log('[auto-update] enabled (' + release.readChannel(dataDir) + ' channel) — check at launch, then every ' + Math.round(ms / 60000) + ' min');
}

module.exports = { checkAndUpdate, startAutoUpdate, restartProcess, writeStatus, isSupervised };
