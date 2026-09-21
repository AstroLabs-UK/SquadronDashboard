const express = require('express');
const path = require('path');
const fs = require('fs');
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

app.disable('x-powered-by');
app.use(securityHeaders);
// Custom embed widgets can be large (up to 20 x 20,000 characters), so allow more than express's 100kb default
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Last-resort defaults, embedded in code, used only if BOTH data.json and its
// backup are missing or corrupted (e.g. the Pi lost power mid-write twice in a row).
// This guarantees the dashboard always boots to something sensible rather than crashing.
const DEFAULT_DATA = {
  squadronName: "Your Squadron Name",
  location: { name: "Your Town", lat: 51.5074, lon: -0.1278 },
  leaderboardCsvUrl: "",
  eventsSeeMoreUrl: "https://cadets.bader.mod.uk/events",
  // Calendar feed: Google Calendar > Settings > your calendar > "Secret address in iCal format"
  icsUrl: "",
  calendarTimezone: "Europe/London",
  calendarDays: 60,
  uniform: { items: [] },
  errorReportUrl: "",
  autoShutdownMinutes: 165,
  instagramEmbedCode: "",
  weatherEmbedCode: "",
  // News panel is always the scraped BBC News feed (no embed code).
  importantInfo: { enabled: false, title: "IMPORTANT INFORMATION", message: "" },
  widgets: { leaderboard: true, news: true, events: true, instagram: true, uniform: true },
  customWidgets: [],
  layout: "auto",
  events: []
};

// Settings are NEVER kept only in memory - every read goes to disk, and every
// write hits disk immediately (fsync'd + atomic), so a power cut can never lose or
// diverge from what's actually saved. See storage.js for the details.
// Safety copy of the settings, kept outside the app folder (see lib/settingsGuard.js).
// If data/ was ever wiped (for example by a bad update), the settings come back on start-up.
const SNAP_DIR = guard.defaultSnapshotDir(__dirname);
const guardActive = !process.env.CANARY;
if (guardActive) {
  if (!fs.existsSync(path.join(DATA_DIR, 'data.json')) && guard.restore(DATA_DIR, SNAP_DIR, { onlyMissing: true })) {
    console.warn('[storage] settings were missing - restored them from ' + SNAP_DIR);
  }
}
const store = createStore({ dir: DATA_DIR, defaults: DEFAULT_DATA, legacyDir: __dirname });
if (guardActive) guard.snapshot(DATA_DIR, SNAP_DIR);

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
  const visible = requireEditor.isEditor(req) ? data : { ...data, icsUrl: '' };
  res.json({ ...visible, icsUrlSet: !!data.icsUrl });
});

app.post('/api/data', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    const updated = store.sanitize(store.load(), req.body);
    store.save(updated);
    guard.snapshot(DATA_DIR, SNAP_DIR);
    res.json({ ok: true, data: updated });
  } catch (e) {
    console.error('[storage] save failed', e);
    res.status(500).json({ ok: false, error: 'save failed' });
  }
});

// ---------- API: weather / news / leaderboard / status / update ----------
app.use(apiLimiter);
app.use(require('./routes/weather')({ store }));
app.use(require('./routes/news')());
app.use(require('./routes/leaderboard')({ store }));
app.use(require('./routes/status')({ store, cwd: __dirname, requireEditor, calendar }));
app.use(require('./routes/schedule')({ store, calendar }));
app.use(control.router);
app.use(require('./routes/config')({ store, dataDir: DATA_DIR, requireEditor, limiter: sensitiveLimiter }));
app.use(require('./routes/update')({ cwd: __dirname, dataDir: DATA_DIR, requireEditor, limiter: sensitiveLimiter }));

if (require.main === module) {
  if (!process.env.CANARY) removeTempFiles(__dirname); // silent start-up housekeeping
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
