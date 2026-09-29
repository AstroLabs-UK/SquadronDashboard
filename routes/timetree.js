// TimeTree connect + calendar/label list for the /edit UI.
// Several TimeTree logins can be linked at once, so every request names the account (accountId).
// Credentials live in data.json. The editor never sees the real password (only "********").
// Connect/labels endpoints accept the mask and use the saved password from disk.
const express = require('express');
const timetree = require('../lib/timetree');
const accountsLib = require('../lib/accounts');

module.exports = function createTimetreeRoutes({ requireEditor, limiter, calendar, store }) {
  const router = express.Router();

  function accountIdFrom(body) {
    const id = String((body && body.accountId) || '').trim();
    return accountsLib.ID_RE.test(id) ? id : '';
  }

  // Email/password from the form, falling back to the saved account when the form still shows the mask.
  function resolveCreds(body) {
    const saved = store && store.load ? store.load() : {};
    const id = accountIdFrom(body);
    const existing = accountsLib.resolveAccounts(saved).find(a => a.id === id && a.type === 'timetree') || {};
    const email = String((body && body.email) || existing.email || '').trim();
    let password = String((body && body.password) || '');
    if (!password || password === accountsLib.MASK) password = String(existing.password || '');
    return { id, email, password, saved, existing };
  }

  // Add or update one TimeTree account in the saved list, leaving every other account untouched.
  function upsertAccount(saved, id, patch) {
    const list = accountsLib.resolveAccounts(saved).map(a => ({ ...a }));
    let acc = list.find(a => a.id === id && a.type === 'timetree');
    if (!acc) {
      acc = { id, type: 'timetree', name: 'TimeTree', enabled: true };
      list.push(acc);
    }
    Object.assign(acc, patch);
    store.save(store.sanitize(saved, { calendarAccounts: list }));
  }

  // Login + list calendars. Also persists email/password when a real password is supplied.
  router.post('/api/timetree/connect', requireEditor, limiter, async (req, res) => {
    try {
      const { id, email, password, saved } = resolveCreds(req.body);
      if (!id) return res.status(400).json({ ok: false, error: 'Missing account id - reload /edit and try again' });
      if (!email) return res.status(400).json({ ok: false, error: 'Enter your TimeTree email' });
      if (!password) {
        return res.status(400).json({
          ok: false,
          error: 'No password saved yet - enter your TimeTree password once and Connect'
        });
      }
      const sessionId = await timetree.login(email, password);
      const calendars = await timetree.fetchCalendars(sessionId);
      if (!calendars.length) {
        return res.status(400).json({ ok: false, error: 'No active calendars on this TimeTree account' });
      }

      // Remember credentials so later tag changes / refresh don't need a re-typed password
      try { upsertAccount(saved, id, { email, password }); } catch (e) { /* best effort */ }

      res.json({ ok: true, calendars });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // List labels (tags) for one account's calendar. Uses the saved password if the form still has the mask.
  // Persists the tag list so the merged tag menu survives a page refresh without logging in again.
  router.post('/api/timetree/labels', requireEditor, limiter, async (req, res) => {
    try {
      const { id, email, password, saved, existing } = resolveCreds(req.body);
      const calendarId = (req.body && req.body.calendarId) != null && req.body.calendarId !== ''
        ? req.body.calendarId
        : existing.calendarId;
      if (!id) return res.status(400).json({ ok: false, error: 'Missing account id - reload /edit and try again' });
      if (!email) return res.status(400).json({ ok: false, error: 'Enter your TimeTree email' });
      if (!password) {
        return res.status(400).json({
          ok: false,
          error: 'No password saved yet - enter your TimeTree password once and click Connect'
        });
      }
      if (calendarId == null || calendarId === '') {
        return res.status(400).json({ ok: false, error: 'Pick a calendar first' });
      }
      const sessionId = await timetree.login(email, password);
      const labels = await timetree.fetchLabels(sessionId, Number(calendarId));

      try {
        const patch = {
          email,
          password,
          calendarId: String(calendarId),
          labels,
          labelsRefreshedAt: Date.now()
        };
        if (req.body && req.body.calendarName) patch.calendarName = String(req.body.calendarName);
        if (req.body && req.body.calendarCode) patch.calendarCode = String(req.body.calendarCode);
        upsertAccount(saved, id, patch);
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
