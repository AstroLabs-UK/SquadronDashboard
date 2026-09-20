// "Force update" plumbing for the /edit page.
//
// The web server can't restart itself (or, in Docker, reach the Pi's own git checkout), so
// it just drops a small request file into the data/ folder. A systemd path unit on the Pi
// (squadron-dashboard-update.path) notices that file and runs update.sh in force mode,
// which deletes the request, updates, restarts the dashboard and writes its result to
// data/update-status.json. This file is the server's side of that hand-off.
const fs = require('fs');
const path = require('path');
const { writeFileDurable } = require('./storage');

const REQUEST_STALE_MS = 5 * 60 * 1000;   // a request nobody picked up for 5 min is stale
const RUNNING_STALE_SECONDS = 10 * 60;    // an update "running" for 10 min is presumed dead

const paths = dir => ({ req: path.join(dir, 'update-request.json'), status: path.join(dir, 'update-status.json') });

function readStatus(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(paths(dir).status, 'utf8'));
    if (o && typeof o === 'object') {
      return { state: String(o.state || ''), message: String(o.message || ''), time: Number(o.time) || 0 };
    }
  } catch (e) { /* no status yet */ }
  return null;
}

function requestUpdate(dir, now = Date.now()) {
  const p = paths(dir);
  try {
    const st = fs.statSync(p.req);
    if (now - st.mtimeMs < REQUEST_STALE_MS) {
      return { ok: false, code: 409, error: 'An update has already been requested - give it a minute.' };
    }
    fs.unlinkSync(p.req); // stale: nothing picked it up
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const s = readStatus(dir);
  if (s && s.state === 'running' && now / 1000 - s.time < RUNNING_STALE_SECONDS) {
    return { ok: false, code: 409, error: 'An update is already running.' };
  }
  writeFileDurable(p.req, JSON.stringify({ requestedAt: now }));
  return { ok: true, requestedAt: now };
}

function getStatus(dir, now = Date.now()) {
  try {
    const st = fs.statSync(paths(dir).req);
    return { state: 'requested', ageSeconds: Math.round((now - st.mtimeMs) / 1000) };
  } catch (e) { /* no pending request */ }
  return readStatus(dir) || { state: 'idle' };
}

module.exports = { requestUpdate, getStatus };
