const fs = require('fs');
const path = require('path');
const express = require('express');
const guard = require('../lib/settingsGuard');

const FORMAT = 'squadron-dashboard-config';

// Export / import the whole configuration as one file, so a replacement device can be set up in
// minutes. The file contains the calendar's private link, so it should be kept private.
// (The editor PIN is NOT included - it belongs to the device.)
module.exports = function configRoutes({ store, dataDir, snapDir, requireEditor, limiter }) {
  const router = express.Router();

  function resolveSnapDir() {
    if (snapDir) return snapDir;
    // dataDir is .../data — app root is parent
    return guard.defaultSnapshotDir(path.dirname(dataDir));
  }

  function ensureDataFile() {
    const main = path.join(dataDir, 'data.json');
    if (fs.existsSync(main)) return true;
    // Persist current in-memory/default settings so a first-time backup always has something.
    try {
      store.save(store.load());
      return fs.existsSync(main);
    } catch (e) {
      return false;
    }
  }

  router.get('/api/config/export', requireEditor, limiter, (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    let appVersion = 'unknown';
    try { appVersion = require('../package.json').version; } catch (e) { /* ignore */ }
    res.setHeader('Content-Disposition', `attachment; filename="squadron-dashboard-config-${stamp}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    const settings = { ...store.load() };
    // Never put the TimeTree password in a downloadable backup
    if (settings.timetreePassword) {
      settings.timetreePassword = '';
      settings.timetreePasswordOmitted = true;
    }
    res.json({ format: FORMAT, version: 1, appVersion, exportedAt: new Date().toISOString(), settings });
  });

  // Force a snapshot of the current settings into the external backup folder (sqndash-data-backup).
  router.post('/api/config/backup', requireEditor, limiter, (req, res) => {
    try {
      if (!ensureDataFile()) {
        return res.status(500).json({ ok: false, error: 'No settings file available to back up' });
      }
      const target = resolveSnapDir();
      const result = guard.snapshot(dataDir, target);
      if (!result || !result.ok) {
        return res.status(500).json({
          ok: false,
          error: (result && result.error) ? result.error : 'Could not write backup'
        });
      }
      res.json({ ok: true, path: target, message: 'Current settings backed up' });
    } catch (e) {
      console.error('[config] backup failed', e);
      res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  router.post('/api/config/import', requireEditor, limiter, (req, res) => {
    try {
      const body = req.body || {};
      if (body.format !== FORMAT || !body.settings || typeof body.settings !== 'object') {
        return res.status(400).json({ ok: false, error: 'That is not a Squadron Dashboard config file' });
      }
      const previous = store.load();
      const incoming = Object.assign({}, body.settings);
      // Keep the device's TimeTree password when the backup omitted it (safe export)
      if (incoming.timetreePasswordOmitted || !incoming.timetreePassword) {
        incoming.timetreePassword = previous.timetreePassword || '';
      }
      delete incoming.timetreePasswordOmitted;
      const imported = store.sanitize(store.defaultData(), incoming);
      try {
        fs.writeFileSync(path.join(dataDir, 'data.before-import.json'), JSON.stringify(previous, null, 2));
      } catch (e) { /* best effort */ }
      store.save(imported);
      try { guard.snapshot(dataDir, resolveSnapDir()); } catch (e) { /* best effort */ }
      const safe = Object.assign({}, imported, {
        timetreePassword: imported.timetreePassword ? '********' : ''
      });
      res.json({ ok: true, data: safe });
    } catch (e) {
      console.error('[config] import failed', e);
      res.status(500).json({ ok: false, error: 'import failed' });
    }
  });

  return router;
};
