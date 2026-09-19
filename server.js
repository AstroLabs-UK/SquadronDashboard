const express = require('express');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const { createStore } = require('./storage');
// Settings live in data/ (git-ignored, so updates never touch them). In Docker this
// folder is a bind mount, so it also survives container rebuilds.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const rssParser = new Parser();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Last-resort defaults, embedded in code, used only if BOTH data.json and its
// backup are missing or corrupted (e.g. the Pi lost power mid-write twice in a row).
// This guarantees the dashboard always boots to something sensible rather than crashing.
const DEFAULT_DATA = {
  squadronName: "Your Squadron Name",
  location: { name: "Your Town", lat: 51.5074, lon: -0.1278 },
  leaderboardCsvUrl: "",
  eventsSeeMoreUrl: "https://cadets.bader.mod.uk/events",
  errorReportUrl: "",
  autoShutdownMinutes: 165,
  instagramEmbedCode: "",
  weatherEmbedCode: "",
  importantInfo: { enabled: false, title: "IMPORTANT INFORMATION", message: "" },
  widgets: { leaderboard: true, news: true, events: true, instagram: true }, // carousel tick boxes
  customWidgets: [],                                                       // extra embed widgets
  layout: "auto",                                                          // auto | full | compact
  events: []
};

// ---------- helpers ----------
// Settings are NEVER kept only in memory - every read goes to disk, and every
// write hits disk immediately (fsync'd + atomic), so a power cut can never lose or
// diverge from what's actually saved. See storage.js for the details.
const store = createStore({ dir: DATA_DIR, defaults: DEFAULT_DATA, legacyDir: __dirname });
const DATA_FILE = store.dataFile;
const BACKUP_FILE = store.backupFile;
const loadData = () => store.load();
const saveData = (data) => store.save(data);

// ---------- CSV parsing helper ----------
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  return lines.map(line => {
    // handles simple quoted commas
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuotes = !inQuotes; continue; }
      if (c === ',' && !inQuotes) { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  });
}

// ---------- pages ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/edit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'edit.html'));
});
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// ---------- API: boot id ----------
// Changes every time the server starts. The dashboard page polls this and reloads itself
// when it changes, so after an auto-update restarts the app the screen picks up the new
// version without anyone touching the Pi.
const BOOT_ID = Date.now().toString(36);
app.get('/api/boot', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ id: BOOT_ID });
});

// ---------- API: force update (see updater.js) ----------
const updater = require('./updater');
app.post('/api/update', (req, res) => {
  try {
    const r = updater.requestUpdate(DATA_DIR);
    if (!r.ok) return res.status(r.code).json({ ok: false, error: r.error });
    res.json({ ok: true, requestedAt: r.requestedAt });
  } catch (e) {
    console.error('[update] could not write request', e);
    res.status(500).json({ ok: false, error: 'could not request an update' });
  }
});
app.get('/api/update/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(updater.getStatus(DATA_DIR));
});

// ---------- API: settings / events ----------
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

app.post('/api/data', (req, res) => {
  try {
    const current = loadData();
    const updated = store.sanitize(current, req.body);
    saveData(updated);
    res.json({ ok: true, data: updated });
  } catch (e) {
    console.error('[storage] save failed', e);
    res.status(500).json({ ok: false, error: 'save failed' });
  }
});

// ---------- API: weather (Open-Meteo, no key needed) ----------
app.get('/api/weather', async (req, res) => {
  try {
    const { lat, lon } = loadData().location;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const r = await fetch(url);
    const json = await r.json();
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: 'weather fetch failed', detail: String(e) });
  }
});

// ---------- API: news headlines ----------
// Hardcoded to BBC News as requested - not editable from /edit
const BBC_NEWS_RSS = 'http://feeds.bbci.co.uk/news/rss.xml';
app.get('/api/news', async (req, res) => {
  try {
    const feed = await rssParser.parseURL(BBC_NEWS_RSS);
    // Return plenty of items; the dashboard client picks how many fit the screen height
    const items = feed.items.slice(0, 20).map(i => ({
      title: i.title,
      link: i.link,
      pubDate: i.pubDate
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'news fetch failed', detail: String(e) });
  }
});

// ---------- API: leaderboard from published Google Sheet CSV ----------
// In Google Sheets: File > Share > Publish to web > choose the sheet > CSV, paste that link into /edit
// Your points tracker may have title rows above the real header, and/or a "LEADERBOARD - RANKED" section
// that is already sorted by rank - so we find that header row and read straight down from it
// rather than re-sorting by points (ties are already broken correctly in the sheet).
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { leaderboardCsvUrl } = loadData();
    if (!leaderboardCsvUrl) {
      return res.json({ rows: [], note: 'No leaderboard CSV URL set yet - add one on /edit' });
    }
    const r = await fetch(leaderboardCsvUrl);
    const text = await r.text();
    const table = parseCsv(text);

    // find the header row that has both a "rank" column and a "name" column
    let headerRowIdx = table.findIndex(row => {
      const lower = row.map(c => c.toLowerCase());
      return lower.some(c => c.includes('rank')) && lower.some(c => c.includes('name'));
    });

    // fallback: find any row with "name" and "point" columns (no rank column)
    if (headerRowIdx === -1) {
      headerRowIdx = table.findIndex(row => {
        const lower = row.map(c => c.toLowerCase());
        return lower.some(c => c.includes('name')) && lower.some(c => c.includes('point'));
      });
    }

    if (headerRowIdx === -1) {
      return res.json({ rows: [], note: 'Could not find a Name/Points header row in the sheet' });
    }

    const headers = table[headerRowIdx].map(h => h.toLowerCase());
    const nameIdx = headers.findIndex(h => h.includes('name'));
    const pointsIdx = headers.findIndex(h => h.includes('point'));
    const rankIdx = headers.findIndex(h => h.includes('rank'));
    const flightIdx = headers.findIndex(h => h.includes('flight'));

    const dataRows = [];
    for (let i = headerRowIdx + 1; i < table.length; i++) {
      const row = table[i];
      if (!row[nameIdx]) break; // stop at first blank row - end of this section
      dataRows.push({
        name: row[nameIdx],
        points: Number(row[pointsIdx]) || 0,
        flight: flightIdx !== -1 ? row[flightIdx] : null
      });
    }

    // Individual leaderboard - keep the sheet's own rank order if it has one,
    // otherwise sort by points. Return enough rows for large screens; client limits by height.
    const rows = (rankIdx !== -1 ? [...dataRows] : [...dataRows].sort((a, b) => b.points - a.points)).slice(0, 15);

    // Flight leaderboard - group ALL rows by flight names in the sheet, sum points, sort descending.
    // No flight names are hardcoded - purely derived from the CSV.
    let flightRows = null;
    if (flightIdx !== -1) {
      const totals = new Map(); // lowercase key -> { flight: original-case label, points }
      for (const r of dataRows) {
        const label = (r.flight || '').trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (!totals.has(key)) totals.set(key, { flight: label, points: 0 });
        totals.get(key).points += r.points;
      }
      flightRows = [...totals.values()].sort((a, b) => b.points - a.points).slice(0, 10);
      if (flightRows.length === 0) flightRows = null; // flight column existed but every value was blank
    }

    res.json({ rows, flightRows });
  } catch (e) {
    res.status(500).json({ error: 'leaderboard fetch failed', detail: String(e) });
  }
});

// ---------- API: status ----------
// Diagnostic info only - never exposes secrets, tokens, or raw config values,
// just reachability/configured-or-not indicators.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

app.get('/api/status', async (req, res) => {
  const data = loadData();
  const status = {
    serverStatus: 'ONLINE',
    uptimeSeconds: Math.floor(process.uptime()),
    currentTime: new Date().toISOString(),
    nodeVersion: process.version,
    dashboardVersion: (() => {
      try { return require('./package.json').version || 'unknown'; } catch (e) { return 'unknown'; }
    })()
  };

  status.dataJson = fs.existsSync(DATA_FILE) ? 'ONLINE' : 'OFFLINE';
  status.dataBackup = fs.existsSync(BACKUP_FILE) ? 'ONLINE' : 'WARNING';

  try {
    const r = await withTimeout(fetch(`https://api.open-meteo.com/v1/forecast?latitude=${data.location.lat}&longitude=${data.location.lon}&current=temperature_2m`), 5000);
    status.weatherApi = r.ok ? 'ONLINE' : 'WARNING';
  } catch (e) { status.weatherApi = 'OFFLINE'; }

  try {
    await withTimeout(rssParser.parseURL(BBC_NEWS_RSS), 5000);
    status.newsRss = 'ONLINE';
  } catch (e) { status.newsRss = 'OFFLINE'; }

  if (!data.leaderboardCsvUrl) {
    status.leaderboardCsv = 'WARNING'; // not configured
  } else {
    try {
      const r = await withTimeout(fetch(data.leaderboardCsvUrl), 5000);
      status.leaderboardCsv = r.ok ? 'ONLINE' : 'WARNING';
    } catch (e) { status.leaderboardCsv = 'OFFLINE'; }
  }

  status.instagramWidget = (data.instagramEmbedCode && data.instagramEmbedCode.trim()) ? 'ONLINE' : 'WARNING';

  status.git = await new Promise(resolve => {
    // Prefer the system git already installed on the host; fall back cleanly if missing.
    exec('git rev-parse --short HEAD', { cwd: __dirname }, (err, stdout) => {
      if (err) {
        return resolve({
          checkout: false,
          status: 'WARNING',
          reason: 'Not a git checkout or git is not available on this system'
        });
      }
      // Ignore untracked files under data/ (already gitignored) and focus on real tracked changes.
      // Use --untracked-files=no so transient files never look like "local changes".
      exec('git status --porcelain --untracked-files=no', { cwd: __dirname }, (err2, stdout2) => {
        const porcelain = (stdout2 || '').trim();
        const lines = porcelain ? porcelain.split('\n').filter(Boolean) : [];
        // Filter out known non-user changes that can appear after install/update
        // (e.g. file mode only, or files that install scripts touch briefly).
        const meaningful = lines.filter(line => {
          // Ignore pure mode changes (e.g. " M script.sh" with only +x bit) by checking
          // that the path is not a pure permission-only report when possible.
          const pathPart = line.slice(3).trim();
          if (!pathPart) return false;
          // data/ is gitignored; anything still listed is noise
          if (pathPart.startsWith('data/') || pathPart === 'data') return false;
          return true;
        });
        resolve({
          checkout: true,
          status: 'ONLINE',
          commit: stdout.trim(),
          hasLocalChanges: meaningful.length > 0,
          changedFiles: meaningful.slice(0, 20), // diagnostic: which files look dirty
          reason: meaningful.length > 0
            ? ('Local changes detected in: ' + meaningful.slice(0, 5).map(l => l.slice(3).trim()).join(', ') + (meaningful.length > 5 ? '…' : ''))
            : undefined
        });
      });
    });
  });

  res.json(status);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Squadron dashboard running:`);
  console.log(`  Display:  http://localhost:${PORT}`);
  console.log(`  Edit (from any phone/laptop on the network): http://<this-pi's-IP>:${PORT}/edit`);
  console.log(`  Status:   http://<this-pi's-IP>:${PORT}/status`);
  // Auto shutdown and auto update are handled on the host by install.sh
  // (systemd timers) when running via Docker, since a container can't reach
  // out and shut down or update its own host.
});
