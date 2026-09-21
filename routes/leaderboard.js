const path = require('path');
const express = require('express');
const { parseCsv } = require('../lib/csv');
const { buildLeaderboard } = require('../lib/leaderboard');
const { createCache } = require('../lib/cache');
const { withRetries, fetchWithTimeout } = require('../lib/upstream');

// In Google Sheets: File > Share > Publish to web > choose the sheet > CSV, paste the link into /edit.
// Cached for 2 minutes; if the sheet can't be reached the last good table is served (stale: true).
module.exports = function leaderboardRoutes({ store, cacheDir }) {
  const router = express.Router();
  const cache = createCache({
    ttlMs: 2 * 60 * 1000,
    staleMs: 6 * 60 * 60 * 1000,
    cooldownMs: 60 * 1000,
    service: 'leaderboard',
    persistPath: cacheDir ? path.join(cacheDir, 'leaderboard.json') : null
  });

  router.get('/api/leaderboard', async (req, res) => {
    try {
      const { leaderboardCsvUrl } = store.load();
      if (!leaderboardCsvUrl) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ rows: [], note: 'No leaderboard CSV URL set yet - add one on /edit' });
      }
      const { value, stale, updatedAt } = await cache.get(leaderboardCsvUrl, async () => {
        return withRetries(async () => {
          const r = await fetchWithTimeout(leaderboardCsvUrl, { timeoutMs: 10000 });
          if (!r.ok) throw new Error('the sheet returned HTTP ' + r.status + ' - is it still published to the web?');
          const text = await r.text();
          if (!text || !String(text).trim()) throw new Error('the sheet returned an empty file');
          return buildLeaderboard(parseCsv(text));
        }, { retries: 1, delaysMs: [500], label: 'leaderboard' });
      });
      res.set('Cache-Control', 'public, max-age=30');
      res.json({ ...value, stale, updatedAt });
    } catch (e) {
      res.status(502).json({ error: 'leaderboard fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
