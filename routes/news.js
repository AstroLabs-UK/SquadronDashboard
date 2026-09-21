const path = require('path');
const express = require('express');
const { createCache } = require('../lib/cache');
const { fetchBbcNews } = require('../lib/bbcNews');
const { withRetries } = require('../lib/upstream');

// Hardcoded to BBC News homepage scrape - not editable from /edit.
// Returns title, short description, thumbnail and link for the dashboard cards.
module.exports = function newsRoutes({ cacheDir } = {}) {
  const router = express.Router();
  const cache = createCache({
    ttlMs: 10 * 60 * 1000,
    staleMs: 6 * 60 * 60 * 1000,
    cooldownMs: 90 * 1000,
    service: 'news',
    persistPath: cacheDir ? path.join(cacheDir, 'news.json') : null
  });

  router.get('/api/news', async (req, res) => {
    try {
      const { value, stale, updatedAt } = await cache.get('bbc-scrape', async () => {
        return withRetries(async () => {
          const items = await fetchBbcNews();
          if (!Array.isArray(items) || !items.length) {
            throw new Error('news feed returned no articles');
          }
          return items;
        }, { retries: 1, delaysMs: [600], label: 'news' });
      });
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ items: value, stale, updatedAt, source: 'bbc' });
    } catch (e) {
      res.status(502).json({ error: 'news fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
