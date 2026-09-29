const express = require('express');
const { setDisplayPower } = require('../lib/hdmiPower');

// Remote control from /edit and /events: reload, notice, wake, sleep.
// Kept in memory on purpose - a restart clears any notice. The display picks it up from /api/boot.
module.exports = function controlRoutes({ requireEditor, limiter, now = Date.now }) {
  const router = express.Router();
  const state = { reloadId: 0, wakeId: 0, sleepId: 0, notice: null }; // notice: { text, until (ms) }

  function publicState() {
    const notice = state.notice && state.notice.until > now()
      ? { text: state.notice.text, secondsLeft: Math.ceil((state.notice.until - now()) / 1000) }
      : null;
    if (!notice) state.notice = null;
    return { reload: state.reloadId, wake: state.wakeId, sleep: state.sleepId, notice };
  }

  function wakeDisplay() {
    state.wakeId++;
    try { setDisplayPower(true); } catch (e) { /* ignore */ }
  }

  function sleepDisplay() {
    state.sleepId++;
    try { setDisplayPower(false); } catch (e) { /* ignore */ }
  }

  router.post('/api/control', requireEditor, limiter, (req, res) => {
    const b = req.body || {};
    if (b.action === 'reload') {
      state.reloadId++;
      return res.json({ ok: true });
    }
    if (b.action === 'notice') {
      const text = String(b.text == null ? '' : b.text).trim().slice(0, 300);
      if (!text) return res.status(400).json({ ok: false, error: 'Type a message first' });
      const minutes = Math.min(720, Math.max(1, Math.round(Number(b.minutes)) || 30));
      state.notice = { text, until: now() + minutes * 60000 };
      return res.json({ ok: true, minutes });
    }
    if (b.action === 'clear-notice') {
      state.notice = null;
      return res.json({ ok: true });
    }
    if (b.action === 'wake') {
      wakeDisplay();
      return res.json({ ok: true, wake: state.wakeId });
    }
    if (b.action === 'sleep') {
      // Soft sleep for the room TV (black cover + best-effort HDMI blank). Not a Pi power-off.
      sleepDisplay();
      return res.json({ ok: true, sleep: state.sleepId });
    }
    res.status(400).json({ ok: false, error: 'Unknown action' });
  });

  return { router, publicState, wakeDisplay, sleepDisplay };
};
