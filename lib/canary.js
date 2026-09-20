// "Canary" safety check for updates.
//
// After new code is downloaded but BEFORE the live dashboard is restarted onto it, start a
// throw-away copy on a spare port with a scratch copy of the settings, and wait for /healthz
// to answer. If it doesn't (syntax error, missing file, crash on boot...) the caller rolls
// back to the previous version and the real dashboard never runs the broken code.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runCanary({ cwd, dataDir, timeoutMs = 45000, entry = 'server.js' }) {
  if (!fs.existsSync(path.join(cwd, entry))) {
    return { ok: false, reason: entry + ' is missing from the new version' };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sqndash-canary-'));
  try {
    // give the test copy the real settings so config problems show up too
    for (const f of ['data.json']) {
      try { fs.copyFileSync(path.join(dataDir, f), path.join(scratch, f)); } catch (e) { /* none yet */ }
    }
    const port = await freePort();
    let output = '';
    let exited = null;
    const child = spawn(process.execPath, [entry], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: scratch, AUTO_UPDATE: '0', CANARY: '1' }
    });
    const keep = chunk => { output = (output + chunk).slice(-800); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', code => { exited = code == null ? -1 : code; });
    child.on('error', e => { exited = -1; output += String(e); });

    const deadline = Date.now() + timeoutMs;
    let result = { ok: false, reason: 'did not answer within ' + Math.round(timeoutMs / 1000) + 's' };
    while (Date.now() < deadline) {
      if (exited !== null) { result = { ok: false, reason: 'crashed on start (exit ' + exited + ')' }; break; }
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(2000) });
        if (r.ok) { result = { ok: true }; break; }
      } catch (e) { /* not up yet */ }
      await sleep(400);
    }
    if (exited === null) {
      child.kill();
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, 2000).unref();
    }
    if (!result.ok && output.trim()) result.output = output.trim();
    return result;
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

module.exports = { runCanary };
