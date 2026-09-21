const express = require('express');
const { createCache } = require('../lib/cache');
const { fetchBbcNews } = require('../lib/bbcNews');

// Hardcoded to BBC News homepage scrape - not editable from /edit.
// Returns title, short description, thumbnail and link for the dashboard cards.
module.exports = function newsRoutes() {
  const router = express.Router();
  const cache = createCache({ ttlMs: 10 * 60 * 1000 });

  router.get('/api/news', async (req, res) => {
    try {
      const { value, stale, updatedAt } = await cache.get('bbc-scrape', async () => {
        return await fetchBbcNews();
      });
      res.json({ items: value, stale, updatedAt, source: 'bbc' });
    } catch (e) {
      res.status(502).json({ error: 'news fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
