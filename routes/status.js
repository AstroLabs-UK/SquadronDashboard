const fs = require('fs');
const express = require('express');
const { git } = require('../lib/git');

// Diagnostic info only - never exposes secrets, tokens, or raw config values,
// just reachability / configured-or-not indicators.
async function probe(url, ms = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? 'ONLINE' : 'WARNING';
  } catch (e) { return 'OFFLINE'; }
}

module.exports = function statusRoutes({ store, cwd, requireEditor }) {
  const router = express.Router();

  // Cheap liveness check: no git, no upstream calls. Used by Docker HEALTHCHECK, the update
  // safety check and the update scripts.
  router.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()) });
  });

  router.get('/api/status', async (req, res) => {
    const data = store.load();
    const status = {
      serverStatus: 'ONLINE',
      uptimeSeconds: Math.floor(process.uptime()),
      currentTime: new Date().toISOString(),
      nodeVersion: process.version,
      dashboardVersion: (() => {
        try { return require('../package.json').version || 'unknown'; } catch (e) { return 'unknown'; }
      })()
    };

    status.dataJson = fs.existsSync(store.dataFile) ? 'ONLINE' : 'OFFLINE';
    status.dataBackup = fs.existsSync(store.backupFile) ? 'ONLINE' : 'WARNING';
    status.editorPin = requireEditor.isProtected() ? 'ONLINE' : 'WARNING';

    const [weather, sheet] = await Promise.all([
      probe(`https://api.open-meteo.com/v1/forecast?latitude=${data.location.lat}&longitude=${data.location.lon}&current=temperature_2m`),
      data.leaderboardCsvUrl ? probe(data.leaderboardCsvUrl) : Promise.resolve('WARNING') // WARNING = not configured
    ]);
    status.weatherApi = weather;
    status.leaderboardCsv = sheet;
    status.newsWidget = (data.newsEmbedCode && data.newsEmbedCode.trim()) ? 'ONLINE' : 'WARNING';
    status.instagramWidget = (data.instagramEmbedCode && data.instagramEmbedCode.trim()) ? 'ONLINE' : 'WARNING';

    const head = await git(['rev-parse', '--short', 'HEAD'], { cwd });
    if (!head.ok) {
      status.git = { checkout: false, status: 'WARNING', reason: 'Not a git checkout or git is not available on this system' };
    } else {
      // Tracked changes only; ignore untracked noise. Skip data/ (gitignored settings).
      const st = await git(['status', '--porcelain', '--untracked-files=no'], { cwd });
      const meaningful = st.out.split('\n').filter(line => {
        if (!line) return false;
        const p = line.slice(3).trim();
        return p && p !== 'data' && !p.startsWith('data/');
      });
      const paths = meaningful.slice(0, 5).map(l => l.slice(3).trim());
      status.git = {
        checkout: true,
        status: 'ONLINE',
        commit: head.out,
        hasLocalChanges: meaningful.length > 0,
        changedFiles: meaningful.slice(0, 20),
        reason: meaningful.length
          ? 'Local changes detected in: ' + paths.join(', ') + (meaningful.length > 5 ? '…' : '')
          : undefined
      };
    }
    res.json(status);
  });
  return router;
};
