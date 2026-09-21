const express = require('express');

// Remote control from /edit: reload every screen, or put a message on top of the display for a while.
// Kept in memory on purpose - a restart clears any notice. The display picks it up from /api/boot.
module.exports = function controlRoutes({ requireEditor, limiter, now = Date.now }) {
  const router = express.Router();
  const state = { reloadId: 0, notice: null }; // notice: { text, until (ms) }

  // What /api/boot tells the display. secondsLeft (not a clock time) so screen clocks don't matter.
  function publicState() {
    const notice = state.notice && state.notice.until > now()
      ? { text: state.notice.text, secondsLeft: Math.ceil((state.notice.until - now()) / 1000) }
      : null;
    if (!notice) state.notice = null;
    return { reload: state.reloadId, notice };
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
    res.status(400).json({ ok: false, error: 'Unknown action' });
  });

  return { router, publicState };
};
