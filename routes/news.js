const express = require('express');
const Parser = require('rss-parser');
const { createCache } = require('../lib/cache');

// Hardcoded to BBC News - not editable from /edit. (The display itself uses the news embed
// widget; this endpoint is kept for anything that wants plain headlines.)
const BBC_NEWS_RSS = 'https://feeds.bbci.co.uk/news/rss.xml';

module.exports = function newsRoutes() {
  const router = express.Router();
  const parser = new Parser({ timeout: 8000 });
  const cache = createCache({ ttlMs: 10 * 60 * 1000 });

  router.get('/api/news', async (req, res) => {
    try {
      const { value, stale, updatedAt } = await cache.get('bbc', async () => {
        const feed = await parser.parseURL(BBC_NEWS_RSS);
        return feed.items.slice(0, 20).map(i => ({ title: i.title, link: i.link, pubDate: i.pubDate }));
      });
      res.json({ items: value, stale, updatedAt });
    } catch (e) {
      res.status(502).json({ error: 'news fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
