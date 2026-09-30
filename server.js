const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('./storage');
const { securityHeaders, rateLimit } = require('./lib/security');
const { createEditorAuth } = require('./lib/auth');
const autoUpdate = require('./autoUpdate');
const hdmiWake = require('./lib/hdmiWake');
const qrCache = require('./lib/qrCache');
const updater = require('./updater');
const themeAssets = require('./lib/themeAssets');
const guard = require('./lib/settingsGuard');
const { removeTempFiles } = require('./lib/cleanup');
const { createCalendarService } = require('./lib/calendar');
const accountsLib = require('./lib/accounts');

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
  showFlightLeaderboard: true,
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
  autoShutdownMinutes: 150,
  autoShutdownMode: "sleep",
  instagramEmbedCode: "",
  weatherEmbedCode: "",
  // News panel is always the scraped BBC News feed (no embed code).
  importantInfo: { enabled: false, title: "IMPORTANT INFORMATION", message: "" },
  widgets: { leaderboard: true, news: true, events: true, instagram: true, uniform: true, chainOfCommand: false },
  customWidgets: [],
  layout: "auto",
  events: [],
  chainOfCommand: { people: [] },
  theme: "rafac",
  branding: { loadingLogo: '', unitCrest: '' }
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
const QR_CACHE_DIR = path.join(CACHE_DIR, 'qr');
try { fs.mkdirSync(QR_CACHE_DIR, { recursive: true }); } catch (e) { /* best effort */ }
const store = createStore({ dir: DATA_DIR, defaults: DEFAULT_DATA, legacyDir: __dirname, snapDir: guardActive ? SNAP_DIR : null });
try { autoUpdate.clearRestartPending(DATA_DIR); } catch (e) {}

// When /edit switches between sleep and power-off, nudge the Pi's shutdown timer unit so it
// does not keep a stale "power off in N minutes" countdown from boot.
function applyShutdownPolicy(mode) {
  try {
    const { execFile } = require('child_process');
    const unit = 'squadron-dashboard-shutdown.service';
    if (mode === 'sleep') {
      execFile('systemctl', ['stop', unit], { timeout: 8000 }, () => {});
      return;
    }
    if (mode === 'poweroff') {
      // Restart so the script re-reads minutes from data.json from now
      execFile('systemctl', ['restart', unit], { timeout: 8000 }, () => {});
    }
  } catch (e) { /* no systemctl (Windows / Docker) — ignore */ }
}

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
app.post('/api/theme', requireEditor, sensitiveLimiter, async (req, res) => {
  try {
    const theme = themeAssets.normalizeTheme(req.body && req.body.theme);
    const current = store.load();
    const updated = store.sanitize(current, { theme });
    store.save(updated);
    const result = await themeAssets.ensureThemeLogo({ dataDir: DATA_DIR, cwd: __dirname, theme, force: true });
    res.json({ ok: true, theme: result.theme, source: result.source });
  } catch (e) {
    console.error('[theme] switch failed', e);
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.get('/theme-logo', async (req, res) => {
  try {
    const data = store.load();
    // Custom unit crest overrides theme logo
    const crest = data.branding && data.branding.unitCrest;
    if (crest && typeof crest === 'string' && crest.startsWith('data:image/')) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(crest);
      if (m) {
        res.setHeader('Content-Type', m[1]);
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(Buffer.from(m[2], 'base64'));
      }
    }
    const theme = data.theme || 'rafac';
    let file = themeAssets.getCachedLogoPath(DATA_DIR);
    if (!file) {
      await themeAssets.ensureThemeLogo({ dataDir: DATA_DIR, cwd: __dirname, theme });
      file = themeAssets.getCachedLogoPath(DATA_DIR);
    }
    if (!file) {
      return res.sendFile(path.join(__dirname, 'public', 'roundel.png'));
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(file);
  } catch (e) {
    console.warn('[theme] serve logo failed', e && e.message ? e.message : e);
    return res.sendFile(path.join(__dirname, 'public', 'roundel.png'));
  }
});

// While an update is applying, send the room screen to a holding page so it
// does not start the normal Astro Labs boot sequence mid-update.
app.get('/', (req, res) => {
  try {
    const st = updater.getStatus(DATA_DIR);
    if (st && (st.state === 'running' || st.state === 'requested')) {
      return res.redirect(302, '/updating');
    }
  } catch (e) { /* fall through to dashboard */ }
  return sendPage('dashboard.html')(req, res);
});
app.get('/updating', sendPage('updating.html'));
app.get('/pin', sendPage('pin.html'));
app.get('/edit', requireEditor, sendPage('edit.html'));
app.get('/events', requireEditor, sendPage('events.html'));
app.get('/status', sendPage('status.html'));

// ---------- API: editor PIN (stylised screen posts here; no PIN is stored in the browser) ----------
// Failures are rate-limited (skipSuccessful); successes are not counted.
app.post('/api/auth/login', pinFailureLimiter, (req, res) => {
  const send = res.json.bind(res);
  res.json = function (body) {
    // Unlocking the editor also wakes the room screen from sleep mode
    if (body && body.ok && control && typeof control.wakeDisplay === 'function') {
      try { control.wakeDisplay(); } catch (e) { /* ignore */ }
    }
    return send(body);
  };
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
const control = require('./routes/control')({
  requireEditor,
  limiter: sensitiveLimiter,
  onWake: () => {
    try { autoUpdate.requestCheckOnWake(); } catch (e) { /* ignore */ }
  }
});
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
    ? { loadingLogo: data.branding.loadingLogo || '', unitCrest: data.branding.unitCrest || '' }
    : { loadingLogo: '', unitCrest: '' };
  const body = {
    ...visible,
    branding,
    icsUrlSet: accountsLib.resolveAccounts(data).some(a => a.type !== 'timetree' && accountsLib.isComplete(a)),
    timetreeConfigured: accountsLib.resolveAccounts(data).some(a => a.type === 'timetree' && accountsLib.isComplete(a)),
    // linked calendars: the editor gets them with passwords masked, the public display gets nothing
    calendarAccounts: requireEditor.isEditor(req)
      ? accountsLib.maskAccounts(accountsLib.resolveAccounts(data), { editor: true })
      : [],
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
    if (updated.autoShutdownMode !== previous.autoShutdownMode
        || updated.autoShutdownMinutes !== previous.autoShutdownMinutes) {
      try { applyShutdownPolicy(updated.autoShutdownMode || 'sleep'); } catch (e) { /* ignore */ }
    }
    // Only keep the active theme crest on disk (fetched from repo / local seed)
    if (updated.theme !== previous.theme || !themeAssets.getCachedLogoPath(DATA_DIR)) {
      themeAssets.ensureThemeLogo({ dataDir: DATA_DIR, cwd: __dirname, theme: updated.theme || 'rafac', force: true })
        .catch(e => console.warn('[theme] crest update failed', e && e.message ? e.message : e));
    }
    try { calendar.clear(); } catch (e) { /* best effort */ }
    try { guard.snapshot(DATA_DIR, SNAP_DIR); } catch (snapErr) {
      console.warn('[storage] external snapshot failed after save', snapErr && snapErr.message ? snapErr.message : snapErr);
    }
    // Don't echo the real password back to the editor
    const safeBrand = updated.branding && typeof updated.branding === 'object'
      ? { loadingLogo: updated.branding.loadingLogo || '', unitCrest: updated.branding.unitCrest || '' }
      : { loadingLogo: '', unitCrest: '' };
    const safe = {
      ...updated,
      timetreePassword: updated.timetreePassword ? '********' : '',
      calendarAccounts: accountsLib.maskAccounts(accountsLib.resolveAccounts(updated), { editor: true }),
      branding: safeBrand
    };
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

app.post('/api/branding/process-crest', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    const imageDataUrl = req.body && req.body.image;
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'Expected a data:image/... payload' });
    }
    if (imageDataUrl.length > 1_500_000) {
      return res.status(400).json({ ok: false, error: 'Image too large' });
    }
    const current = store.load();
    const next = store.sanitize(current, {
      branding: { unitCrest: imageDataUrl, loadingLogo: (current.branding && current.branding.loadingLogo) || '' }
    });
    store.save(next);
    try { guard.snapshot(DATA_DIR, SNAP_DIR); } catch (e) {}
    res.json({ ok: true, unitCrest: imageDataUrl });
  } catch (e) {
    console.error('[branding] process-crest failed', e);
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.post('/api/branding/clear-crest', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    const current = store.load();
    const next = store.sanitize(current, {
      branding: { unitCrest: '', loadingLogo: (current.branding && current.branding.loadingLogo) || '' }
    });
    store.save(next);
    try { guard.snapshot(DATA_DIR, SNAP_DIR); } catch (e) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'clear failed' });
  }
});

app.post('/api/branding/clear-logo', requireEditor, sensitiveLimiter, (req, res) => {
  try {
    const current = store.load();
    const next = store.sanitize(current, { branding: { loadingLogo: '', unitCrest: '' } });
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

// QR PNG temp cache (generated on the room browser, stored under data/cache/qr until restart or memory pressure)
app.get('/api/qr/:key.png', apiLimiter, (req, res) => {
  const key = String(req.params.key || '');
  const buf = qrCache.getPng(QR_CACHE_DIR, key);
  if (!buf) return res.status(404).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-cache');
  res.send(buf);
});
app.put('/api/qr/:key.png', apiLimiter, express.raw({ type: 'image/png', limit: '1mb' }), (req, res) => {
  const key = String(req.params.key || '');
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!qrCache.putPng(QR_CACHE_DIR, key, body)) {
    return res.status(400).json({ ok: false, error: 'Could not store QR' });
  }
  res.json({ ok: true });
});
app.get('/api/memory', apiLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const avail = qrCache.readAvailablePercent();
  res.json({
    availablePercent: avail,
    pressure: qrCache.underPressure(),
    thresholdAvailablePercent: 15
  });
});

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
// Runs for every linked TimeTree account that has a calendar picked.
const LABEL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
async function refreshTimetreeLabels() {
  try {
    const s = store.load();
    const list = accountsLib.resolveAccounts(s).map(a => ({ ...a }));
    const due = list.filter(a => {
      if (a.type !== 'timetree' || a.enabled === false) return false;
      if (!a.email || !a.password || !a.calendarId) return false;
      const last = Number(a.labelsRefreshedAt) || 0;
      return !(last && Date.now() - last < LABEL_REFRESH_MS - 60 * 60 * 1000); // within ~week
    });
    if (!due.length) return;
    const timetree = require('./lib/timetree');
    let changed = false;
    for (const a of due) {
      try {
        const sessionId = await timetree.login(a.email, a.password);
        a.labels = await timetree.fetchLabels(sessionId, Number(a.calendarId));
        a.labelsRefreshedAt = Date.now();
        changed = true;
        console.log('[timetree] refreshed', a.labels.length, 'label(s) for', a.name || a.id);
      } catch (e) {
        console.warn('[timetree] label refresh failed for', a.name || a.id + ':', e && e.message ? e.message : e);
      }
    }
    if (changed) {
      // apply only the refreshed tag lists onto the latest saved settings (the editor may have saved meanwhile)
      const fresh = new Map(due.map(a => [a.id, a]));
      const latest = accountsLib.resolveAccounts(store.load()).map(a => {
        const f = fresh.get(a.id);
        return f && f.labelsRefreshedAt ? { ...a, labels: f.labels, labelsRefreshedAt: f.labelsRefreshedAt } : a;
      });
      store.save(store.sanitize(store.load(), { calendarAccounts: latest }));
    }
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
    themeAssets.ensureThemeLogo({ dataDir: DATA_DIR, cwd: __dirname, theme: (store.load().theme || 'rafac') })
      .catch(e => console.warn('[theme] initial crest', e && e.message ? e.message : e));
    // TV power-on: DRM connector disconnected → connected bumps wake for the room screen
    try {
      hdmiWake.startHdmiWake({
        onConnect: () => {
          if (control && typeof control.wakeDisplay === 'function') control.wakeDisplay();
        }
      });
    } catch (e) {
      console.warn('[hdmi] watcher failed to start', e && e.message ? e.message : e);
    }
    try {
      qrCache.startMemoryWatch(QR_CACHE_DIR);
    } catch (e) {
      console.warn('[qr-cache] memory watch failed', e && e.message ? e.message : e);
    }
  });
}

module.exports = app;
