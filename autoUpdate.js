// In-process auto-update for hosts that run Node directly (especially Windows).
// Checks GitHub at launch and on an interval; if behind, resets to remote, reinstalls
// deps if needed, and restarts this process. Settings in data/ are gitignored and kept.
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function run(cmd, opts = {}) {
  return new Promise(resolve => {
    exec(cmd, {
      cwd: opts.cwd,
      timeout: opts.timeout || 60000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) }
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code : 0,
        out: (stdout || '').trim(),
        err: (stderr || '').trim()
      });
    });
  });
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

async function resolveRemoteRef(cwd) {
  for (const ref of ['origin/main', 'origin/master', 'origin/HEAD']) {
    const r = await run('git rev-parse --verify ' + ref, { cwd, timeout: 10000 });
    const sha = (r.out || '').split(/\s/)[0];
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) return ref;
  }
  return null;
}

/**
 * @returns {{ updated: boolean, reason: string, local?: string, remote?: string }}
 */
async function checkAndUpdate({ cwd, dataDir, force = false }) {
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    return { updated: false, reason: 'not a git repository' };
  }

  writeStatus(dataDir, 'running', 'Checking GitHub for updates…');

  let fetch = await run('git fetch origin --prune', { cwd, timeout: 45000 });
  if (!fetch.ok) fetch = await run('git fetch --prune', { cwd, timeout: 45000 });
  if (!fetch.ok) {
    writeStatus(dataDir, 'error', 'Could not reach GitHub');
    return { updated: false, reason: 'fetch failed' };
  }

  const local = await run('git rev-parse HEAD', { cwd });
  const localSha = (local.out || '').split(/\s/)[0];
  if (!localSha) {
    writeStatus(dataDir, 'error', 'Could not read local commit');
    return { updated: false, reason: 'no local HEAD' };
  }

  const remoteRef = await resolveRemoteRef(cwd);
  if (!remoteRef) {
    writeStatus(dataDir, 'error', 'No origin/main or origin/master');
    return { updated: false, reason: 'no remote ref' };
  }

  const remote = await run('git rev-parse ' + remoteRef, { cwd });
  const remoteSha = (remote.out || '').split(/\s/)[0];
  if (!remoteSha) {
    return { updated: false, reason: 'no remote sha' };
  }

  if (!force && localSha === remoteSha) {
    const short = (await run('git rev-parse --short HEAD', { cwd })).out || localSha.slice(0, 7);
    writeStatus(dataDir, 'done', 'Already on the latest version (' + short + ')');
    return { updated: false, reason: 'up to date', local: localSha, remote: remoteSha };
  }

  writeStatus(dataDir, 'running', 'Downloading update from GitHub…');

  // Keep settings: data/ is gitignored
  const reset = await run('git reset --hard ' + remoteRef, { cwd, timeout: 30000 });
  if (!reset.ok) {
    writeStatus(dataDir, 'error', 'git reset failed: ' + (reset.err || reset.out || 'unknown'));
    return { updated: false, reason: 'reset failed' };
  }
  await run('git clean -fd', { cwd, timeout: 15000 });

  // Dependencies may have changed
  await run('npm install --omit=dev', { cwd, timeout: 180000 });

  const short = (await run('git rev-parse --short HEAD', { cwd })).out || remoteSha.slice(0, 7);
  writeStatus(dataDir, 'done', 'Updated to ' + short + ' — restarting');
  return { updated: true, reason: 'updated', local: localSha, remote: remoteSha, short };
}

function restartProcess(cwd) {
  const node = process.execPath;
  const args = process.argv.slice(1);
  // Delay the new process so this one can release port 3000 first (critical on Windows)
  if (process.platform === 'win32') {
    const quotedArgs = args.map(a => '"' + String(a).replace(/"/g, '\\"') + '"').join(' ');
    const cmdline = 'timeout /t 2 /nobreak >nul & "' + node + '" ' + quotedArgs;
    spawn('cmd.exe', ['/c', cmdline], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env
    }).unref();
  } else {
    const quotedArgs = args.map(a => JSON.stringify(String(a))).join(' ');
    spawn('sh', ['-c', 'sleep 1; exec ' + JSON.stringify(node) + ' ' + quotedArgs], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env
    }).unref();
  }
  process.exit(0);
}

function startAutoUpdate({ cwd, dataDir, intervalMs }) {
  const enabled = process.env.AUTO_UPDATE !== '0' && process.env.AUTO_UPDATE !== 'false';
  if (!enabled) {
    console.log('[auto-update] disabled (set AUTO_UPDATE=1 to enable)');
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

  // At launch (slight delay so the server can finish binding the port first)
  setTimeout(() => tick('check at launch'), 8000);
  setInterval(() => tick('scheduled check'), ms);
  console.log('[auto-update] enabled — check at launch, then every ' + Math.round(ms / 60000) + ' min');
}

module.exports = { checkAndUpdate, startAutoUpdate, restartProcess, writeStatus };
