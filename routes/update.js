const fs = require('fs');
const path = require('path');
const express = require('express');
const { git, firstWord, isSha } = require('../lib/git');
const release = require('../lib/release');
const updater = require('../updater');
const autoUpdate = require('../autoUpdate');

module.exports = function updateRoutes({ cwd, dataDir, requireEditor, limiter }) {
  const router = express.Router();

  // Local checkout vs the update target (newest release tag by default - see lib/release.js).
  // The JSON keeps the same shape as before (local / remote / upToDate / behind / ahead) so the
  // /edit page works unchanged; `remote.ref` now says which release or branch is the target.
  router.get('/api/version', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const head = await git(['rev-parse', 'HEAD'], { cwd });
      if (!isSha(firstWord(head.out))) {
        return res.json({ ok: false, error: 'Not a git checkout or git is not available on this machine', local: null, remote: null });
      }
      const localFull = firstWord(head.out);
      const localShort = firstWord((await git(['rev-parse', '--short', 'HEAD'], { cwd })).out) || localFull.slice(0, 7);
      const localMsg = (await git(['log', '-1', '--pretty=%s'], { cwd })).out || '';
      const local = { full: localFull, short: localShort, message: localMsg };

      await release.fetchRemote(cwd, 15000); // best effort - offline is fine
      const target = await release.resolveTarget({ cwd, dataDir });
      if (!target) {
        return res.json({ ok: true, local, remote: null, upToDate: null, behind: null, ahead: null,
          error: 'Could not find a release tag or origin/Stable — run: git fetch origin' });
      }
      const behind = parseInt((await git(['rev-list', '--count', 'HEAD..' + target.sha], { cwd })).out, 10) || 0;
      const ahead = parseInt((await git(['rev-list', '--count', target.sha + '..HEAD'], { cwd })).out, 10) || 0;
      res.json({
        ok: true,
        local,
        remote: { full: target.sha, short: target.short, message: target.message, ref: target.label },
        channel: target.channel,
        upToDate: localFull === target.sha,
        behind,
        ahead
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e), local: null, remote: null });
    }
  });

  // Force update. Under systemd or Docker the request is handed to the Pi's update watcher
  // (see updater.js / update.sh). On Windows / bare Node it runs in-process.
  router.post('/api/update', requireEditor, limiter, async (req, res) => {
    try {
      const hasGit = fs.existsSync(path.join(cwd, '.git'));
      const inProcess = hasGit && !autoUpdate.isSupervised() && process.env.UPDATE_IN_PROCESS !== '0';
      if (inProcess) {
        const requestedAt = Date.now();
        res.json({ ok: true, requestedAt, mode: 'in-process' });
        // Respond first, then update + restart so the HTTP client is not cut off mid-body
        setTimeout(async () => {
          try {
            const result = await autoUpdate.checkAndUpdate({ cwd, dataDir, force: true });
            if (result.updated) {
              console.log('[update] force update applied — restarting');
              autoUpdate.restartProcess(cwd);
            } else {
              console.log('[update] force update: ' + result.reason);
            }
          } catch (e) {
            console.error('[update] in-process failed', e);
            autoUpdate.writeStatus(dataDir, 'error', String(e && e.message ? e.message : e));
          }
        }, 300);
        return;
      }
      const r = updater.requestUpdate(dataDir);
      if (!r.ok) return res.status(r.code).json({ ok: false, error: r.error });
      res.json({ ok: true, requestedAt: r.requestedAt, mode: 'request-file' });
    } catch (e) {
      console.error('[update] could not request update', e);
      res.status(500).json({ ok: false, error: 'could not request an update' });
    }
  });

  router.get('/api/update/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(updater.getStatus(dataDir));
  });

  return router;
};
