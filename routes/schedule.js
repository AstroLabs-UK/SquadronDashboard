const express = require('express');
const { buildEventList } = require('../lib/events');
const { buildUniform } = require('../lib/uniform');

// Events shown on the display = the hand-typed list from /edit + upcoming items from the calendar
// feed. Uniform = "Uniform:" lines from calendar events + the uniform list from /edit.
// If the calendar can't be reached the typed events still work, and the reply says why.
module.exports = function eventsRoutes({ store, calendar }) {
  const router = express.Router();

  const calendarInfo = cal => ({
    configured: cal.configured, ok: cal.ok, stale: cal.stale, updatedAt: cal.updatedAt,
    ...(cal.error ? { error: cal.error } : {})
  });

  router.get('/api/events', async (req, res) => {
    try {
      const s = store.load();
      const cal = await calendar.get();
      const events = buildEventList({ manual: s.events, calendar: cal.events, tz: cal.tz, now: Date.now() });
      res.json({ events, calendar: calendarInfo(cal), updatedAt: cal.updatedAt });
    } catch (e) {
      res.status(500).json({ error: 'events failed', detail: String(e && e.message ? e.message : e) });
    }
  });

  router.get('/api/uniform', async (req, res) => {
    try {
      const s = store.load();
      const cal = await calendar.get();
      const uniform = buildUniform({ calendar: cal.events, manual: (s.uniform || {}).items, tz: cal.tz, now: Date.now() });
      res.json({ ...uniform, calendar: calendarInfo(cal), updatedAt: cal.updatedAt });
    } catch (e) {
      res.status(500).json({ error: 'uniform failed', detail: String(e && e.message ? e.message : e) });
    }
  });

  return router;
};
