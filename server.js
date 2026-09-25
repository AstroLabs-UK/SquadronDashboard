const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('./storage');
const { securityHeaders, rateLimit } = require('./lib/security');
const { createEditorAuth } = require('./lib/auth');
const autoUpdate = require('./autoUpdate');
const guard = require('./lib/settingsGuard');
const { removeTempFiles } = require('./lib/cleanup');
const { createCalendarService } = require('./lib/calendar');

const app = express();
const PORT = process.env.PORT || 3000;
// Not called HOST on purpose: some shells export HOST=<computer name>, which would make the app bind to the wrong address
const HOST = process.env.SQNDASH_HOST || '0.0.0.0';
// Settings live in data/ (git-ignored, so updates never touch them). In Docker this
// folder is a bind mount, so it also survives container rebuilds.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Last-good upstream payloads (weather/news/leaderboard) survive restarts here.
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, 'cache');

app.disable('x-powered-by');
app.use(securityHeaders);
// Custom embed widgets can be large (up to 20 x 20,000 characters), so allow more than express's 100kb default
app.use(express.json({ limit: '1mb' }));
// Static assets change only on deploy/update; short cache cuts repeat transfers on the kiosk.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      // HTML is the shell the kiosk keeps open; prefer revalidate so updates show up.
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Last-resort defaults, embedded in code, used only if BOTH data.json and its
// backup are missing or corrupted (e.g. the Pi lost power mid-write twice in a row).
// This guarantees the dashboard always boots to something sensible rather than crashing.
const DEFAULT_DATA = {
  squadronName: "Your Squadron Name",
  location: { name: "Your Town", lat: 51.5074, lon: -0.1278 },
  leaderboardCsvUrl: "",
  eventsSeeMoreUrl: "https://cadets.bader.mod.uk/events",
  // Calendar: ICS URL (Google/Outlook/iCloud) OR built-in TimeTree login
  icsUrl: "",
  calendarSource: "ics",
  calendarTimezone: "Europe/London",
  calendarDays: 60,
  timetreeEmail: "",
  timetreePassword: "",
  timetreeCalendarId: "",
  timetreeCalendarName: "",
  timetreeCalendarCode: "",
  timetreeLabelIds: [],
  timetreeLabels: [],
  timetreeUniformLabelIds: [],
  timetreeLabelsRefreshedAt: null,
  uniform: { items: [] },
  errorReportUrl: "",
  autoShutdownMinutes: 165,
  instagramEmbedCode: "",
  weatherEmbedCode: "",
  // News panel is always the scraped BBC News feed (no embed code).
  importantInfo: { enabled: false, title: "IMPORTANT INFORMATION", message: "" },
  widgets: { leaderboard: true, news: true, events: true, instagram: true, uniform: true, chainOfCommand: false },
  customWidgets: [],
  layout: "auto",
  events: [],
  chainOfCommand: { people: [] },
  branding: { loadingLogo: '' }
};

// Settings are NEVER kept only in memory - every read goes to disk, and every
// write hits disk immediately (fsync'd + atomic), so a power cut can never lose or
// diverge from what's actually saved. See storage.js for the details.
// Safety copy of the settings, kept outside the app folder (see lib/settingsGuard.js).
// If data/ was ever wiped (for example by a bad update), the settings come back on start-up.
const SNAP_DIR = guard.defaultSnapshotDir(__dirname);
const guardActive = !process.env.CANARY;
if (guardActive) {
  // Recover settings carefully: never replace a good in-app file with an older/empty snapshot.
  const main = path.join(DATA_DIR, 'data.json');
  const backup = path.join(DATA_DIR, 'data.backup.json');
  const readable = (file) => {
    try {
      if (!fs.existsSync(file)) return false;
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      return !!(o && typeof o === 'object' && !Array.isArray(o));
    } catch (e) { return false; }
  };
  const mainOk = readable(main);
  const backupOk = readable(backup);
  if (!mainOk && backupOk) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(backup, main);
      console.warn('[storage] restored data.json from data.backup.json (previous settings)');
    } catch (e) {
      console.warn('[storage] could not restore from data.backup.json:', e && e.message ? e.message : e);
    }
  } else if (!mainOk && !backupOk) {
    // Only then fall back to the external sqndash-data-backup snapshot.
    if (guard.restore(DATA_DIR, SNAP_DIR, { onlyMissing: false })) {
      console.warn('[storage] restored current settings from ' + SNAP_DIR);
    } else if (guard.restore(DATA_DIR, SNAP_DIR, { onlyMissing: true })) {
      console.warn('[storage] settings were missing - restored them from ' + SNAP_DIR);
    }
  }
}
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* best effort */ }
const store = createStore({ dir: DATA_DIR, defaults: DEFAULT_DATA, legacyDir: __dirname, snapDir: guardActive ? SNAP_DIR : null });
try { autoUpdate.clearRestartPending(DATA_DIR); } catch (e) {}
if (guardActive) {
  try {
    const main = path.join(DATA_DIR, 'data.json');
    if (fs.existsSync(main)) {
      const o = JSON.parse(fs.readFileSync(main, 'utf8'));
      // Snapshot only when we have real saved settings (not a missing/empty bootstrap).
      if (o && typeof o === 'object' && (o.squadronName || o.location || o.widgets)) {
        guard.snapshot(DATA_DIR, SNAP_DIR);
      }
    }
  } catch (e) { /* skip startup snapshot if unreadable */ }
}

// ---------- protection ----------
// General limit for the API (the kiosk polls a few times a minute, so this is generous),
// a tight one for anything that changes things or shells out to git, and a lockout for
// wrong-PIN guessing (only failed attempts count).
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 240 });
const sensitiveLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.SENSITIVE_RATE_MAX) || 20 }); // the env var is only for automated tests
const pinFailureLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10, skipSuccessful: true,
  message: 'Too many wrong PIN attempts - wait a few minutes and try again.'
});
const requireEditor = createEditorAuth({ dataDir: DATA_DIR, failureLimiter: pinFailureLimiter });

// ---------- pages ----------
const sendPage = name => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
app.get('/', sendPage('dashboard.html'));
app.get('/pin', sendPage('pin.html'));
app.get('/edit', requireEditor, sendPage('edit.html'));
app.get('/status', sendPage('status.html'));

// ---------- API: editor PIN (stylised screen posts here; no PIN is stored in the browser) ----------
// Failures are rate-limited (skipSuccessful); successes are not counted.
app.post('/api/auth/login', pinFailureLimiter, (req, res) => {
  requireEditor.login(req, res);
});
app.post('/api/auth/logout', (req, res) => {
  requireEditor.logout(req, res);
});
app.get('/api/auth/check', (req, res) => {
  requireEditor.check(req, res);
});

// ---------- API: boot id ----------
// Changes every time the server starts. The dashboard page polls this and reloads itself
// when it changes, so after an auto-update restarts the app the screen picks up the new
// version without anyone touching the Pi.
const BOOT_ID = Date.now().toString(36);
const calendar = createCalendarService({ store });
const control = require('./routes/control')({ requireEditor, limiter: sensitiveLimiter });
app.get('/api/boot', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // reload / notice come from the buttons on /edit (see routes/control.js)
  res.json({ id: BOOT_ID, ...control.publicState() });
});

// ---------- API: settings / events ----------
// The calendar's secret link is only sent to the editor - the public display never needs it.
app.get('/api/data', apiLimiter, (req, res) => {
  const data = store.load();
  const visible = requireEditor.isEditor(req)
    ? data
    : { ...data, icsUrl: '', timetreePassword: '', timetreeEmail: '' };
  const branding = data.branding && typeof data.branding === 'object'
    ? { loadingLogo: data.branding.loadingLogo || '' }
    : { loadingLogo: '' };
  const body = {
    ...visible,
    branding,
    icsUrlSet: !!data.icsUrl,
    timetreeConfigured: !!(data.timetreeEmail && data.timetreePassword),
    // never echo the real password back even to the editor — UI keeps a "unchanged" blank
    timetreePassword: requireEditor.isEditor(req) ? (data.timetreePassword ? '********' : '') : ''
  };
  const etag = '"' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex') + '"';
  res.set('ETag', etag);
  // Always send the body. A bare 304 with no body breaks dashboard/edit fetch().json().
  res.set('Cache-Control', 'no-store');
  res.json(body);
});

app.post('/api/data', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: 'Invalid settings payload' });
    }
    const previous = store.load();
    const updated = store.sanitize(previous, req.body);
    store.save(updated);
    try { calendar.clear(); } catch (e) { /* best effort */ }
    try { guard.snapshot(DATA_DIR, SNAP_DIR); } catch (snapErr) {
      console.warn('[storage] external snapshot failed after save', snapErr && snapErr.message ? snapErr.message : snapErr);
    }
    // Don't echo the real password back to the editor
    const safeBrand = updated.branding && typeof updated.branding === 'object'
      ? { loadingLogo: updated.branding.loadingLogo || '' }
      : { loadingLogo: '' };
    const safe = { ...updated, timetreePassword: updated.timetreePassword ? '********' : '', branding: safeBrand };
    res.json({ ok: true, data: safe });
  } catch (e) {
    console.error('[storage] save failed', e);
    // Previous valid configuration remains on disk; do not wipe it.
    res.status(500).json({ ok: false, error: 'save failed' });
  }
});

// ---------- API: branding / loading logo ----------
app.post('/api/branding/process-logo', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    const body = req.body || {};
    const imageDataUrl = typeof body.image === 'string' ? body.image : '';
    if (!imageDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'Expected a data:image/... payload' });
    }
    if (imageDataUrl.length > 1_500_000) {
      return res.status(400).json({ ok: false, error: 'Image too large' });
    }
    const current = store.load();
    const next = store.sanitize(current, {
      branding: { loadingLogo: imageDataUrl }
    });
    store.save(next);
    try { guard.snapshot(DATA_DIR, SNAP_DIR); } catch (e) {}
    res.json({
      ok: true,
      loadingLogo: imageDataUrl,
      note: 'Logo saved and resized; previous logo replaced. Transparent PNG works best.'
    });
  } catch (e) {
    console.error('[branding] process-logo failed', e);
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.post('/api/branding/clear-logo', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    const current = store.load();
    const next = store.sanitize(current, { branding: { loadingLogo: '' } });
    store.save(next);
    try { guard.snapshot(DATA_DIR, SNAP_DIR); } catch (e) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'clear failed' });
  }
});

// Restart the dashboard process (editor only). Used after an update is staged on disk.
app.post('/api/restart', requireEditor, sensitiveLimiter, (req, res) => {
  res.json({ ok: true, message: 'Restarting…' });
  setTimeout(() => {
    try {
      autoUpdate.restartProcess(__dirname);
    } catch (e) {
      console.error('[restart] failed', e);
    }
  }, 300);
});


// ---------- API: weather / news / leaderboard / status / update ----------
app.use(apiLimiter);
app.use(require('./routes/weather')({ store, cacheDir: CACHE_DIR }));
app.use(require('./routes/news')({ cacheDir: CACHE_DIR }));
app.use(require('./routes/leaderboard')({ store, cacheDir: CACHE_DIR }));
app.use(require('./routes/status')({ store, cwd: __dirname, dataDir: DATA_DIR, requireEditor, calendar }));
app.use(require('./routes/schedule')({ store, calendar }));
app.use(control.router);
app.use(require('./routes/config')({ store, dataDir: DATA_DIR, snapDir: SNAP_DIR, requireEditor, limiter: sensitiveLimiter }));
app.use(require('./routes/update')({ cwd: __dirname, dataDir: DATA_DIR, requireEditor, limiter: sensitiveLimiter }));
app.use(require('./routes/timetree')({ requireEditor, limiter: sensitiveLimiter, calendar, store }));

// Never let an unexpected handler crash the process; log and return a safe response.
app.use((err, req, res, next) => {
  console.error('[server] unhandled route error', req.method, req.path, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'internal error' });
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection', reason && reason.stack ? reason.stack : reason);
});

if (require.main === module) {
  if (!process.env.CANARY) removeTempFiles(__dirname); // silent start-up housekeeping
  
// ---- TimeTree label catalogue: refresh about weekly so renamed tags stay current ----
const LABEL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
async function refreshTimetreeLabels() {
  try {
    const s = store.load();
    if (s.calendarSource !== 'timetree') return;
    if (!s.timetreeEmail || !s.timetreePassword || !s.timetreeCalendarId) return;
    const last = Number(s.timetreeLabelsRefreshedAt) || 0;
    if (last && Date.now() - last < LABEL_REFRESH_MS - 60 * 60 * 1000) return; // within ~week
    const timetree = require('./lib/timetree');
    const sessionId = await timetree.login(s.timetreeEmail, s.timetreePassword);
    const labels = await timetree.fetchLabels(sessionId, Number(s.timetreeCalendarId));
    store.save(store.sanitize(s, {
      timetreeLabels: labels,
      timetreeLabelsRefreshedAt: Date.now()
    }));
    console.log('[timetree] refreshed', labels.length, 'label(s) for calendar', s.timetreeCalendarId);
  } catch (e) {
    console.warn('[timetree] label refresh failed:', e && e.message ? e.message : e);
  }
}
setTimeout(refreshTimetreeLabels, 90 * 1000); // after boot settles
setInterval(refreshTimetreeLabels, 24 * 60 * 60 * 1000); // check daily; no-op if still fresh

app.listen(PORT, HOST, () => {
    console.log(`Squadron dashboard running:`);
    console.log(`  Display:  http://localhost:${PORT}`);
    console.log(`  Edit:     http://localhost:${PORT}/edit${requireEditor.isProtected() ? '  (PIN protected)' : '  (NO PIN SET - run: sqndash --set-pin)'}`);
    console.log(`  Status:   http://localhost:${PORT}/status`);
    console.log(`  Health:   http://localhost:${PORT}/healthz`);
    // Windows / bare-metal Node: check GitHub at launch and every 5 minutes
    // (skipped under systemd / Docker and during the update safety check - see autoUpdate.js)
    autoUpdate.startAutoUpdate({ cwd: __dirname, dataDir: DATA_DIR, intervalMs: 5 * 60 * 1000 });
  });
}

module.exports = app;
