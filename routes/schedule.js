const express = require('express');
const { buildEventList } = require('../lib/events');
const { buildUniform } = require('../lib/uniform');

module.exports = function eventsRoutes({ store, calendar }) {
  const router = express.Router();

  function labelNamesFromSettings(s, idKey) {
    const ids = Array.isArray(s[idKey]) ? s[idKey].map(Number) : [];
    if (!ids.length) return [];
    const catalogue = Array.isArray(s.timetreeLabels) ? s.timetreeLabels : [];
    const byId = new Map(catalogue.map(l => [Number(l.id), String(l.name || '')]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }

  const calendarInfo = (cal, s) => ({
    configured: cal.configured,
    ok: cal.ok,
    stale: cal.stale,
    updatedAt: cal.updatedAt,
    source: cal.source || (s && s.calendarSource) || 'ics',
    calendarName: (s && s.timetreeCalendarName) || '',
    ...(cal.error ? { error: cal.error } : {})
  });

  router.get('/api/events', async (req, res) => {
    try {
      const s = store.load();
      const cal = await calendar.get();
      const events = buildEventList({ manual: s.events, calendar: cal.events, tz: cal.tz, now: Date.now() });
      res.json({
        events,
        calendar: calendarInfo(cal, s),
        updatedAt: cal.updatedAt
      });
    } catch (e) {
      res.status(500).json({ error: 'events failed', detail: String(e && e.message ? e.message : e) });
    }
  });

  router.get('/api/uniform', async (req, res) => {
    try {
      const s = store.load();
      const cal = await calendar.get();
      const uniformLabelNames = labelNamesFromSettings(s, 'timetreeUniformLabelIds')
        .map(n => n.toLowerCase());
      const uniform = buildUniform({
        calendar: cal.events,
        manual: (s.uniform || {}).items,
        tz: cal.tz,
        now: Date.now(),
        uniformLabelNames
      });
      res.json({ ...uniform, calendar: calendarInfo(cal, s), updatedAt: cal.updatedAt });
    } catch (e) {
      res.status(500).json({ error: 'uniform failed', detail: String(e && e.message ? e.message : e) });
    }
  });

  return router;
};
