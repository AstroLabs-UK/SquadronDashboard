// TimeTree connect + calendar/label list for the /edit UI.
// Credentials live in data.json. The editor never sees the real password (only "********").
// Connect/labels endpoints accept the mask and use the saved password from disk.
const express = require('express');
const timetree = require('../lib/timetree');

module.exports = function createTimetreeRoutes({ requireEditor, limiter, calendar, store }) {
  const router = express.Router();

  function resolveCreds(body) {
    const saved = store && store.load ? store.load() : {};
    const email = String((body && body.email) || saved.timetreeEmail || '').trim();
    let password = String((body && body.password) || '');
    if (!password || password === '********') {
      password = String(saved.timetreePassword || '');
    }
    return { email, password, saved };
  }

  // Login + list calendars. Also persists email/password when a real password is supplied.
  router.post('/api/timetree/connect', requireEditor, limiter, async (req, res) => {
    try {
      const { email, password, saved } = resolveCreds(req.body);
      if (!email) return res.status(400).json({ ok: false, error: 'Enter your TimeTree email' });
      if (!password) {
        return res.status(400).json({
          ok: false,
          error: 'No password saved yet — enter your TimeTree password once and Save, or type it here'
        });
      }
      const sessionId = await timetree.login(email, password);
      const calendars = await timetree.fetchCalendars(sessionId);
      if (!calendars.length) {
        return res.status(400).json({ ok: false, error: 'No active calendars on this TimeTree account' });
      }

      // Remember credentials so later tag changes / refresh don't need a re-typed password
      try {
        store.save(store.sanitize(saved, {
          timetreeEmail: email,
          timetreePassword: password
        }));
      } catch (e) { /* best effort */ }

      res.json({ ok: true, calendars });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // List labels for a calendar. Uses saved password if the form still has the mask.
  // Persists the label catalogue so the edit page can show tags after a refresh without logging in again.
  router.post('/api/timetree/labels', requireEditor, limiter, async (req, res) => {
    try {
      const { email, password, saved } = resolveCreds(req.body);
      const calendarId = (req.body && req.body.calendarId) != null && req.body.calendarId !== ''
        ? req.body.calendarId
        : saved.timetreeCalendarId;
      if (!email) return res.status(400).json({ ok: false, error: 'Enter your TimeTree email' });
      if (!password) {
        return res.status(400).json({
          ok: false,
          error: 'No password saved yet — enter your TimeTree password once and click Connect'
        });
      }
      if (calendarId == null || calendarId === '') {
        return res.status(400).json({ ok: false, error: 'Pick a calendar first' });
      }
      const sessionId = await timetree.login(email, password);
      const labels = await timetree.fetchLabels(sessionId, Number(calendarId));

      // Persist catalogue so tags survive page refresh without another login
      try {
        const patch = {
          timetreeEmail: email,
          timetreePassword: password,
          timetreeCalendarId: String(calendarId),
          timetreeLabels: labels
        };
        // keep name/code if we know them
        if (req.body && req.body.calendarName) patch.timetreeCalendarName = String(req.body.calendarName);
        if (req.body && req.body.calendarCode) patch.timetreeCalendarCode = String(req.body.calendarCode);
        store.save(store.sanitize(saved, patch));
      } catch (e) { /* best effort */ }

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
