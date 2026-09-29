const express = require('express');
const { buildEventList } = require('../lib/events');
const { buildUniform } = require('../lib/uniform');
const accountsLib = require('../lib/accounts');

module.exports = function eventsRoutes({ store, calendar }) {
  const router = express.Router();

  const calendarInfo = (cal, s) => ({
    configured: cal.configured,
    ok: cal.ok,
    stale: cal.stale,
    updatedAt: cal.updatedAt,
    source: cal.source || (s && s.calendarSource) || 'ics',
    calendarName: (s && s.timetreeCalendarName) || '',
    accounts: cal.accounts || [],
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
      // tags ticked as "uniform" in any linked TimeTree account (same-named tags count as one)
      const uniformLabelNames = accountsLib.uniformTagNames(accountsLib.resolveAccounts(s));
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
