const express = require('express');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_FILE = path.join(__dirname, 'data.backup.json');
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
  instagramEmbedCode: "",
  weatherEmbedCode: "",
  importantInfo: { enabled: false, title: "IMPORTANT INFORMATION", message: "" },
  events: []
};

// ---------- helpers ----------
// Settings are NEVER kept only in memory - every read goes to disk, and every
// write hits disk immediately, so a power cut can never lose or diverge from
// what's actually saved.
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.warn('[storage] data.json missing or corrupt (' + e.message + ') - trying backup');
    try {
      const backupRaw = fs.readFileSync(BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(backupRaw); // validate before trusting it
      try { fs.writeFileSync(DATA_FILE, backupRaw); } catch (e3) { /* best effort restore */ }
      console.warn('[storage] restored data.json from backup');
      return parsed;
    } catch (e2) {
      console.warn('[storage] backup also missing or corrupt (' + e2.message + ') - falling back to built-in defaults');
      saveData(DEFAULT_DATA);
      return DEFAULT_DATA;
    }
  }
}

function saveData(data) {
  const json = JSON.stringify(data, null, 2);
  // Atomic write: write to a temp file, then rename over the real file.
  // A rename is a single filesystem operation, so a power cut can never leave
  // data.json half-written/corrupted - it's either the old version or the new one.
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, json);
  fs.renameSync(tmpFile, DATA_FILE);
  // Always keep a redundant copy on solid storage too, written the same atomic way.
  const tmpBackup = BACKUP_FILE + '.tmp';
  fs.writeFileSync(tmpBackup, json);
  fs.renameSync(tmpBackup, BACKUP_FILE);
}

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

// ---------- API: settings / events ----------
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

app.post('/api/data', (req, res) => {
  const current = loadData();
  const updated = { ...current, ...req.body };
  saveData(updated);
  res.json({ ok: true, data: updated });
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
    const items = feed.items.slice(0, 8).map(i => ({
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

    // Individual leaderboard - unchanged behaviour: keep the sheet's own rank order
    // if it has one, otherwise sort by points ourselves.
    const rows = (rankIdx !== -1 ? [...dataRows] : [...dataRows].sort((a, b) => b.points - a.points)).slice(0, 5);

    // Flight leaderboard - group ALL rows (not just the top 5 individuals) by
    // whatever flight names appear in the sheet, sum their points, sort descending.
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
      flightRows = [...totals.values()].sort((a, b) => b.points - a.points);
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
    exec('git rev-parse --short HEAD', { cwd: __dirname }, (err, stdout) => {
      if (err) return resolve({ checkout: false, status: 'WARNING' });
      exec('git status --porcelain', { cwd: __dirname }, (err2, stdout2) => {
        resolve({
          checkout: true,
          status: 'ONLINE',
          commit: stdout.trim(),
          hasLocalChanges: !!(stdout2 && stdout2.trim())
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
