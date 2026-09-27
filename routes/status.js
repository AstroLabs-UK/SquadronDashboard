const fs = require('fs');
const express = require('express');
const { git } = require('../lib/git');
const autoUpdate = require('../autoUpdate');
const sysinfo = require('../lib/sysinfo');
const { getRegisteredStats } = require('../lib/cache');

// Diagnostic info only - never exposes secrets, tokens, or raw config values,
// just reachability / configured-or-not indicators.
async function probe(url, ms = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? 'ONLINE' : 'WARNING';
  } catch (e) { return 'OFFLINE'; }
}

function sourceStatus(stats, probeResult) {
  if (!stats) return probeResult || 'WARNING';
  if (stats.usingStale) return 'WARNING';
  if (stats.consecutiveFailures > 0 && !stats.hasCache) return 'OFFLINE';
  if (probeResult === 'OFFLINE' && stats.hasCache) return 'WARNING';
  return probeResult || (stats.hasCache ? 'ONLINE' : 'WARNING');
}

function fmtSource(stats) {
  if (!stats) return null;
  return {
    lastSuccessAt: stats.lastSuccessAt || null,
    lastErrorAt: stats.lastErrorAt || null,
    lastError: stats.lastError || null,
    consecutiveFailures: stats.consecutiveFailures || 0,
    usingCachedData: !!stats.usingStale,
    hasCache: !!stats.hasCache
  };
}

module.exports = function statusRoutes({ store, cwd, dataDir, requireEditor, calendar }) {
  const router = express.Router();

  // Cheap liveness check: no git, no upstream calls. Used by Docker HEALTHCHECK, the update
  // safety check and the update scripts.
  router.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()) });
  });

  router.get('/api/status', async (req, res) => {
    const data = store.load();
    const caches = getRegisteredStats();
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
      data.leaderboardCsvUrl ? probe(data.leaderboardCsvUrl) : Promise.resolve('WARNING')
    ]);
    status.weatherApi = sourceStatus(caches.weather, weather);
    status.leaderboardCsv = data.leaderboardCsvUrl
      ? sourceStatus(caches.leaderboard, sheet)
      : 'WARNING';
    status.newsWidget = sourceStatus(caches.news, caches.news && caches.news.hasCache ? 'ONLINE' : 'WARNING');

    status.sources = {
      weather: fmtSource(caches.weather),
      news: fmtSource(caches.news),
      leaderboard: fmtSource(caches.leaderboard)
    };

    // Calendar feed (cached - this doesn't add extra requests to Google beyond calendar service)
    const cal = calendar ? await calendar.get() : { configured: false };
    status.calendar = !cal.configured ? 'WARNING' : !cal.ok ? 'OFFLINE' : cal.stale ? 'WARNING' : 'ONLINE';
    status.calendarInfo = {
      configured: !!cal.configured,
      events: cal.configured && cal.ok ? cal.events.length : null,
      updatedAt: cal.updatedAt || null,
      error: cal.error || undefined,
      usingCachedData: !!cal.stale,
      source: cal.source || data.calendarSource || 'ics',
      calendarName: data.timetreeCalendarName || '',
      labelCount: Array.isArray(data.timetreeLabels) ? data.timetreeLabels.length : 0,
      selectedLabelCount: Array.isArray(data.timetreeLabelIds) ? data.timetreeLabelIds.length : 0,
      lastLabelRefreshAt: data.timetreeLabelsRefreshedAt || null,
      timetreeEmail: data.calendarSource === 'timetree' && data.timetreeEmail
        ? String(data.timetreeEmail).replace(/(.{2}).+(@.+)/, '$1…$2')
        : ''
    };
    status.system = sysinfo.collect({ dir: cwd });
    status.instagramWidget = (data.instagramEmbedCode && data.instagramEmbedCode.trim()) ? 'ONLINE' : 'WARNING';

    const head = await git(['rev-parse', '--short', 'HEAD'], { cwd });
    if (!head.ok) {
      status.git = { checkout: false, status: 'WARNING', reason: 'Not a git checkout or git is not available on this system' };
    } else {
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
    const pending = autoUpdate.readRestartPending(dataDir || require('path').join(cwd, 'data'));
    status.restartPending = pending ? {
      ready: true,
      label: pending.label || '',
      short: pending.short || '',
      time: pending.time || null
    } : { ready: false };

    res.json(status);
  });
  return router;
};

