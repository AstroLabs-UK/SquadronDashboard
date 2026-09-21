const path = require('path');
const express = require('express');
const { createCache } = require('../lib/cache');
const { withRetries, fetchWithTimeout } = require('../lib/upstream');

// Open-Meteo needs no API key. Cached for 5 minutes; if it's unreachable the last good
// reading (up to 6 hours old, including across restarts) is served, flagged with "stale": true.
module.exports = function weatherRoutes({ store, cacheDir }) {
  const router = express.Router();
  const cache = createCache({
    ttlMs: 5 * 60 * 1000,
    staleMs: 6 * 60 * 60 * 1000,
    cooldownMs: 60 * 1000,
    service: 'weather',
    persistPath: cacheDir ? path.join(cacheDir, 'weather.json') : null
  });

  router.get('/api/weather', async (req, res) => {
    try {
      const { lat, lon } = store.load().location;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
      const { value, stale, updatedAt } = await cache.get(`${lat},${lon}`, async () => {
        return withRetries(async () => {
          const r = await fetchWithTimeout(url, { timeoutMs: 8000 });
          if (!r.ok) throw new Error('weather service returned HTTP ' + r.status);
          const body = await r.json();
          if (!body || typeof body !== 'object' || !body.current) {
            throw new Error('weather service returned an unexpected response');
          }
          return body;
        }, { retries: 1, delaysMs: [500], label: 'weather' });
      });
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ...value, stale, updatedAt });
    } catch (e) {
      res.status(502).json({ error: 'weather fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
