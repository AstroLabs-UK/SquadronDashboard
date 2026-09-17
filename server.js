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
  socials: [
    { label: "Instagram", url: "https://instagram.com/", handle: "@yourhandle" },
    { label: "Facebook", url: "https://facebook.com/", handle: "Your Squadron" },
    { label: "X / Twitter", url: "https://x.com/", handle: "@yourhandle" }
  ],
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

// ---------- auto shutdown ----------
// The Pi may also be switched off at the wall at any time - that's fine, since
// nothing is ever held only in memory. This just handles the "normal" case of
// being left running: power the Pi off automatically 2.5 hours after boot.
// Requires passwordless sudo for shutdown - see README.md for the one-line setup.
const AUTO_SHUTDOWN_MINUTES = 165; // 2h 45m
function scheduleAutoShutdown() {
  if (process.platform !== 'linux') {
    console.log('[auto-shutdown] skipped - not running on Linux (fine for local testing)');
    return;
  }
  // Cancel any shutdown left scheduled from a previous run, then schedule a fresh one.
  exec('sudo shutdown -c', () => {
    exec(`sudo shutdown -h +${AUTO_SHUTDOWN_MINUTES}`, (err) => {
      if (err) {
        console.warn('[auto-shutdown] could not schedule automatic shutdown - see README.md ("Auto shutdown setup")');
      } else {
        console.log('[auto-shutdown] Pi will power off automatically in 2h 45m');
      }
    });
  });
}

// ---------- auto update ----------
// Periodically checks the GitHub repo for new commits. If there's a newer
// version, pulls it, reinstalls dependencies if needed, then restarts itself
// via systemd (which is why setup.sh grants passwordless permission for that
// specific restart command). Silently does nothing if this isn't a git
// checkout (e.g. local testing) or there's no internet right now.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
function checkForUpdates() {
  exec('git rev-parse --is-inside-work-tree', { cwd: __dirname }, (err) => {
    if (err) return; // not a git checkout - nothing to do
    exec('git fetch --quiet && git rev-parse HEAD && git rev-parse @{u}', { cwd: __dirname }, (err2, stdout) => {
      if (err2) { console.warn('[auto-update] could not check for updates:', err2.message); return; }
      const [local, remote] = stdout.trim().split('\n');
      if (local === remote) return; // already up to date
      console.log('[auto-update] update found - pulling latest version...');
      exec('git pull --quiet && npm install --omit=dev --quiet', { cwd: __dirname }, (err3) => {
        if (err3) { console.warn('[auto-update] update failed:', err3.message); return; }
        console.log('[auto-update] updated successfully - restarting...');
        exec('sudo systemctl restart squadron-dashboard.service', (err4) => {
          if (err4) console.warn('[auto-update] pulled latest code but could not restart automatically - restart the service manually to apply it');
          // if the restart command succeeds, this process is about to be killed and replaced - nothing more to do here
        });
      });
    });
  });
}


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

    const dataRows = [];
    for (let i = headerRowIdx + 1; i < table.length; i++) {
      const row = table[i];
      if (!row[nameIdx]) break; // stop at first blank row - end of this section
      dataRows.push({ name: row[nameIdx], points: Number(row[pointsIdx]) || 0 });
    }

    // if the sheet already provides rank order, keep it as-is; otherwise sort by points
    const rows = (rankIdx !== -1 ? dataRows : dataRows.sort((a, b) => b.points - a.points)).slice(0, 5);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: 'leaderboard fetch failed', detail: String(e) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Squadron dashboard running:`);
  console.log(`  Display:  http://localhost:${PORT}`);
  console.log(`  Edit (from any phone/laptop on the network): http://<this-pi's-IP>:${PORT}/edit`);
  scheduleAutoShutdown();
  setTimeout(checkForUpdates, 60 * 1000); // one check shortly after boot
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
});
