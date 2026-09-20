const express = require('express');
const { parseCsv } = require('../lib/csv');
const { buildLeaderboard } = require('../lib/leaderboard');
const { createCache } = require('../lib/cache');

// In Google Sheets: File > Share > Publish to web > choose the sheet > CSV, paste the link into /edit.
// Cached for 2 minutes; if the sheet can't be reached the last good table is served (stale: true).
module.exports = function leaderboardRoutes({ store }) {
  const router = express.Router();
  const cache = createCache({ ttlMs: 2 * 60 * 1000 });

  router.get('/api/leaderboard', async (req, res) => {
    try {
      const { leaderboardCsvUrl } = store.load();
      if (!leaderboardCsvUrl) {
        return res.json({ rows: [], note: 'No leaderboard CSV URL set yet - add one on /edit' });
      }
      const { value, stale, updatedAt } = await cache.get(leaderboardCsvUrl, async () => {
        const r = await fetch(leaderboardCsvUrl, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('the sheet returned HTTP ' + r.status + ' - is it still published to the web?');
        return buildLeaderboard(parseCsv(await r.text()));
      });
      res.json({ ...value, stale, updatedAt });
    } catch (e) {
      res.status(502).json({ error: 'leaderboard fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
