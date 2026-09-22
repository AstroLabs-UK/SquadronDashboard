// TimeTree connect + calendar/label list for the /edit UI.
// POST /api/timetree/connect  { email, password } → { ok, calendars }
// POST /api/timetree/labels   { email, password, calendarId } → { ok, labels }
const express = require('express');
const timetree = require('../lib/timetree');

module.exports = function createTimetreeRoutes({ requireEditor, limiter, calendar }) {
  const router = express.Router();

  function resolvePassword(bodyPassword, storePassword) {
    const pw = String(bodyPassword || '');
    if (pw && pw !== '********') return pw;
    return String(storePassword || '');
  }

  router.post('/api/timetree/connect', requireEditor, limiter, async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim();
      // Allow re-connect using saved password when UI still has the mask
      const store = require('../storage'); // not ideal - get from closure if available
      // password must be provided fresh or we reject (safer than reading disk here without store)
      const password = String((req.body && req.body.password) || '');
      if (!email) return res.status(400).json({ ok: false, error: 'Enter your TimeTree email' });
      if (!password || password === '********') {
        return res.status(400).json({ ok: false, error: 'Enter your TimeTree password (re-type it if you just opened the page)' });
      }
      const sessionId = await timetree.login(email, password);
      const calendars = await timetree.fetchCalendars(sessionId);
      if (!calendars.length) {
        return res.status(400).json({ ok: false, error: 'No active calendars on this TimeTree account' });
      }
      res.json({ ok: true, calendars });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // List labels (tags) for a chosen calendar
  router.post('/api/timetree/labels', requireEditor, limiter, async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim();
      const password = String((req.body && req.body.password) || '');
      const calendarId = (req.body && req.body.calendarId);
      if (!email) return res.status(400).json({ ok: false, error: 'Enter your TimeTree email' });
      if (!password || password === '********') {
        return res.status(400).json({ ok: false, error: 'Enter your TimeTree password (re-type it if you just opened the page)' });
      }
      if (calendarId == null || calendarId === '') {
        return res.status(400).json({ ok: false, error: 'Pick a calendar first' });
      }
      const sessionId = await timetree.login(email, password);
      const labels = await timetree.fetchLabels(sessionId, Number(calendarId));
      res.json({ ok: true, labels });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  router.post('/api/timetree/refresh', requireEditor, limiter, (req, res) => {
    try {
      if (calendar && typeof calendar.clear === 'function') calendar.clear();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  return router;
};
