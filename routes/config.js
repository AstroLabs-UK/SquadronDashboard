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

  router.get('/api/config/export', requireEditor, limiter, (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    let appVersion = 'unknown';
    try { appVersion = require('../package.json').version; } catch (e) { /* ignore */ }
    res.setHeader('Content-Disposition', `attachment; filename="squadron-dashboard-config-${stamp}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ format: FORMAT, version: 1, appVersion, exportedAt: new Date().toISOString(), settings: store.load() });
  });

  // Force a snapshot of the current settings into the external backup folder (sqndash-data-backup).
  router.post('/api/config/backup', requireEditor, limiter, (req, res) => {
    try {
      const target = snapDir || guard.defaultSnapshotDir(path.join(dataDir, '..'));
      const ok = guard.snapshot(dataDir, target);
      if (!ok) {
        return res.status(500).json({ ok: false, error: 'Could not write backup (is data.json present?)' });
      }
      res.json({ ok: true, path: target, message: 'Current settings backed up' });
    } catch (e) {
      console.error('[config] backup failed', e);
      res.status(500).json({ ok: false, error: 'backup failed' });
    }
  });

  router.post('/api/config/import', requireEditor, limiter, (req, res) => {
    try {
      const body = req.body || {};
      if (body.format !== FORMAT || !body.settings || typeof body.settings !== 'object') {
        return res.status(400).json({ ok: false, error: 'That is not a Squadron Dashboard config file' });
      }
      // Anything the file doesn't mention goes back to its default; every value is validated
      // exactly as if it had been typed into /edit.
      const imported = store.sanitize(store.defaultData(), body.settings);
      try { // keep what was there, just in case
        fs.writeFileSync(path.join(dataDir, 'data.before-import.json'), JSON.stringify(store.load(), null, 2));
      } catch (e) { /* best effort */ }
      store.save(imported);
      if (snapDir) {
        try { guard.snapshot(dataDir, snapDir); } catch (e) { /* best effort */ }
      }
      res.json({ ok: true, data: imported });
    } catch (e) {
      console.error('[config] import failed', e);
      res.status(500).json({ ok: false, error: 'import failed' });
    }
  });

  return router;
};
