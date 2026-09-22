// TimeTree connect + calendar list for the /edit UI.
// POST /api/timetree/connect  { email, password } → { ok, calendars: [{id,name,code}] }
// Requires editor PIN. Credentials are saved only when the user hits Save on /edit.
const express = require('express');
const timetree = require('../lib/timetree');

module.exports = function createTimetreeRoutes({ requireEditor, limiter, calendar }) {
  const router = express.Router();

  router.post('/api/timetree/connect', requireEditor, limiter, async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim();
      const password = String((req.body && req.body.password) || '');
      // If the UI sent the masked password, the real one is already on disk — tell the client to save first
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
      const msg = String(e && e.message ? e.message : e);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  // Optional: clear calendar cache after credentials change
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
