const express = require('express');
const { createCache } = require('../lib/cache');

// Open-Meteo needs no API key. Cached for 5 minutes; if it's unreachable the last good
// reading (up to 6 hours old) is served, flagged with "stale": true.
module.exports = function weatherRoutes({ store }) {
  const router = express.Router();
  const cache = createCache({ ttlMs: 5 * 60 * 1000 });

  router.get('/api/weather', async (req, res) => {
    try {
      const { lat, lon } = store.load().location;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
      const { value, stale, updatedAt } = await cache.get(`${lat},${lon}`, async () => {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('weather service returned HTTP ' + r.status);
        return r.json();
      });
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ...value, stale, updatedAt });
    } catch (e) {
      res.status(502).json({ error: 'weather fetch failed', detail: String(e && e.message ? e.message : e) });
    }
  });
  return router;
};
