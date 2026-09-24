// Durable settings storage for the Squadron Dashboard.
//
// Goals: settings saved on /edit must survive (1) the Pi losing power at any moment,
// (2) app restarts, and (3) code updates from GitHub.
//   - Settings live in the data/ folder, which is git-ignored, so updates never touch it.
//   - Every write is fsync'd and atomically renamed, so a power cut leaves either the
//     complete old file or the complete new file - never a half-written one.
//   - A second copy (data.backup.json) is kept; a corrupt/empty main file is restored from it.
//   - Anything missing from a saved file (e.g. a setting added in a later update) is
//     filled in from the defaults, so old settings files keep working after updates.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.trim() !== ''; } catch (e) { return false; }
}

function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { /* not supported everywhere - best effort */ }
}

function writeFileDurable(file, contents) {
  const tmp = file + '.tmp'; // same folder as the target, so the rename is atomic
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd); // force the bytes onto the SD card before renaming
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function readJsonObject(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  return parsed;
}

function createStore({ dir, defaults, legacyDir, snapDir }) {
  const dataFile = path.join(dir, 'data.json');
  const backupFile = path.join(dir, 'data.backup.json');
  fs.mkdirSync(dir, { recursive: true });
  // In-memory cache with mtime check: avoids constant SD reads, but still picks up
  // changes written by another process (or a second instance) when data.json changes.
  let mem = null;
  let memMtime = null;

  function withDefaults(d) {
    return {
      ...defaults,
      ...d,
      location: { ...defaults.location, ...(d.location && typeof d.location === 'object' ? d.location : {}) },
      importantInfo: { ...defaults.importantInfo, ...(d.importantInfo && typeof d.importantInfo === 'object' ? d.importantInfo : {}) },
      widgets: { ...defaults.widgets, ...(d.widgets && typeof d.widgets === 'object' ? d.widgets : {}) },
      uniform: { ...defaults.uniform, ...(d.uniform && typeof d.uniform === 'object' ? d.uniform : {}) },
      customWidgets: Array.isArray(d.customWidgets) ? d.customWidgets : defaults.customWidgets,
      events: Array.isArray(d.events) ? d.events : defaults.events,
      chainOfCommand: {
        ...(defaults.chainOfCommand || { people: [] }),
        ...(d.chainOfCommand && typeof d.chainOfCommand === 'object' ? d.chainOfCommand : {}),
        people: Array.isArray(d.chainOfCommand && d.chainOfCommand.people)
          ? d.chainOfCommand.people
          : (defaults.chainOfCommand && defaults.chainOfCommand.people) || []
      },
      branding: {
        ...(defaults.branding || { loadingLogo: '' }),
        ...(d.branding && typeof d.branding === 'object' ? d.branding : {})
      }
    };
  }

  function save(data) {
    const json = JSON.stringify(data, null, 2);
    // Keep the *previous* settings in data.backup.json (not a twin of the new write),
    // so a bad save can still roll back to the last good configuration.
    try {
      if (fs.existsSync(dataFile)) {
        const prev = fs.readFileSync(dataFile, 'utf8');
        JSON.parse(prev); // only rotate if current file is still valid JSON
        writeFileDurable(backupFile, prev);
      }
    } catch (e) { /* keep existing backup if rotation fails */ }
    writeFileDurable(dataFile, json);
    // If there was no previous file, seed backup with the same content so restore always has something.
    if (!fs.existsSync(backupFile)) {
      try { writeFileDurable(backupFile, json); } catch (e) { /* best effort */ }
    }
    mem = withDefaults(data);
    try { memMtime = fs.statSync(dataFile).mtimeMs; } catch (e) { memMtime = null; }
  }

  function tryLoadFile(file, label) {
    const parsed = readJsonObject(file);
    console.warn('[storage] restored data.json from ' + label);
    try { writeFileDurable(dataFile, JSON.stringify(parsed, null, 2)); } catch (e3) { /* best effort */ }
    try { memMtime = fs.statSync(dataFile).mtimeMs; } catch (e) { memMtime = null; }
    return withDefaults(parsed);
  }

  function load() {
    try {
      const st = fs.statSync(dataFile);
      if (mem && memMtime === st.mtimeMs) return mem;
      mem = withDefaults(readJsonObject(dataFile));
      memMtime = st.mtimeMs;
      return mem;
    } catch (e) {
      console.warn('[storage] data.json missing or corrupt (' + e.message + ') - trying previous settings backup');
      try {
        mem = tryLoadFile(backupFile, 'data.backup.json (previous settings)');
        return mem;
      } catch (e2) {
        // Prefer the external current-settings snapshot over built-in defaults.
        if (snapDir) {
          try {
            const snapFile = path.join(snapDir, 'data.json');
            mem = tryLoadFile(snapFile, 'external snapshot ' + snapDir);
            return mem;
          } catch (eSnap) {
            console.warn('[storage] external snapshot also unusable (' + eSnap.message + ')');
          }
        }
        console.warn('[storage] no usable settings backup - using built-in defaults (not writing over existing files)');
        const fresh = withDefaults({});
        // Only seed disk when there is nothing to protect. Never clobber a file that exists
        // (even if unreadable) with factory defaults — that is how real /edit settings get wiped.
        const hadAny = fs.existsSync(dataFile) || fs.existsSync(backupFile);
        if (!hadAny) {
          try { save(fresh); } catch (e4) { /* still serve defaults */ }
        }
        mem = fresh;
        return fresh;
      }
    }
  }

  // One-time migration: older versions kept data.json next to server.js. If there's no
  // settings file in data/ yet, adopt the old one instead of starting from scratch.
  if (legacyDir && !fs.existsSync(dataFile) && !fs.existsSync(backupFile)) {
    for (const name of ['data.json', 'data.backup.json']) {
      try {
        const legacy = path.join(legacyDir, name);
        if (fs.existsSync(legacy)) {
          readJsonObject(legacy); // only adopt it if it's valid
          writeFileDurable(path.join(dir, name), fs.readFileSync(legacy, 'utf8'));
          console.warn('[storage] migrated ' + name + ' into ' + dir);
        }
      } catch (e) { /* ignore unreadable legacy file */ }
    }
  }

  // Accepts only well-formed values for known settings; anything else is ignored and the
  // current saved value is kept, so a bad request can't break the dashboard.
  function sanitize(current, incoming) {
    const out = { ...current };
    if (!incoming || typeof incoming !== 'object') return out;
    const isStr = v => typeof v === 'string';

    if (isStr(incoming.squadronName) && incoming.squadronName.trim()) out.squadronName = incoming.squadronName;
    // URLs: blank (to switch a feature off) or a real http(s) address. Anything else -
    // javascript:, file://, a bare word - is ignored and the saved value is kept. This also
    // stops the server being pointed at file:// or other odd schemes when it fetches the sheet.
    for (const k of ['leaderboardCsvUrl', 'eventsSeeMoreUrl', 'errorReportUrl']) {
      if (isStr(incoming[k])) {
        const v = incoming[k].trim();
        if (v === '' || isHttpUrl(v)) out[k] = v;
      }
    }
    // Calendar feed (Google Calendar "secret address in iCal format" etc.). webcal:// is https:// under another name.
    if (isStr(incoming.icsUrl)) {
      const v = incoming.icsUrl.trim().replace(/^webcal:\/\//i, 'https://');
      if (v === '' || isHttpUrl(v)) out.icsUrl = v;
    }
    if (incoming.calendarSource === 'ics' || incoming.calendarSource === 'timetree') out.calendarSource = incoming.calendarSource;
    if (isStr(incoming.calendarTimezone) && isValidTimeZone(incoming.calendarTimezone.trim())) out.calendarTimezone = incoming.calendarTimezone.trim();
    const calDays = Number(incoming.calendarDays);
    if (Number.isFinite(calDays) && calDays >= 14 && calDays <= 365) out.calendarDays = Math.round(calDays);
    // Built-in TimeTree credentials + chosen calendar (password left unchanged if UI sent the mask)
    if (isStr(incoming.timetreeEmail)) out.timetreeEmail = incoming.timetreeEmail.trim().slice(0, 200);
    if (isStr(incoming.timetreePassword)) {
      const pw = incoming.timetreePassword;
      if (pw && pw !== '********') out.timetreePassword = pw.slice(0, 200);
      if (pw === '') out.timetreePassword = '';
    }
    if (incoming.timetreeCalendarId != null) {
      const id = String(incoming.timetreeCalendarId).trim();
      out.timetreeCalendarId = id.slice(0, 40);
    }
    if (isStr(incoming.timetreeCalendarName)) out.timetreeCalendarName = incoming.timetreeCalendarName.trim().slice(0, 120);
    if (isStr(incoming.timetreeCalendarCode)) out.timetreeCalendarCode = incoming.timetreeCalendarCode.trim().slice(0, 80);
    if (Array.isArray(incoming.timetreeLabelIds)) {
      out.timetreeLabelIds = incoming.timetreeLabelIds
        .map(x => Number(x))
        .filter(n => Number.isFinite(n))
        .slice(0, 20);
    }
    if (Array.isArray(incoming.timetreeLabels)) {
      out.timetreeLabels = incoming.timetreeLabels
        .filter(l => l && (l.id != null))
        .map(l => ({
          id: Number(l.id),
          name: String(l.name || ('Tag ' + l.id)).slice(0, 80),
          color: String(l.color || '').slice(0, 30)
        }))
        .filter(l => Number.isFinite(l.id))
        .slice(0, 30);
    }
    if (Array.isArray(incoming.timetreeUniformLabelIds)) {
      out.timetreeUniformLabelIds = incoming.timetreeUniformLabelIds
        .map(x => Number(x)).filter(n => Number.isFinite(n)).slice(0, 20);
    }
    if (typeof incoming.timetreeLabelsRefreshedAt === 'number' && Number.isFinite(incoming.timetreeLabelsRefreshedAt)) {
      out.timetreeLabelsRefreshedAt = incoming.timetreeLabelsRefreshedAt;
    }
    for (const k of ['instagramEmbedCode', 'weatherEmbedCode']) {
      if (isStr(incoming[k])) out[k] = incoming[k];
    }
    // newsEmbedCode is no longer used (news is always the scraped BBC feed)
    const mins = Number(incoming.autoShutdownMinutes);
    if (Number.isFinite(mins) && mins >= 1) out.autoShutdownMinutes = Math.round(mins);

    const loc = incoming.location;
    if (loc && typeof loc === 'object') {
      const next = { ...current.location };
      if (isStr(loc.name) && loc.name.trim()) next.name = loc.name;
      if (typeof loc.lat === 'number' && Number.isFinite(loc.lat) && Math.abs(loc.lat) <= 90) next.lat = loc.lat;
      if (typeof loc.lon === 'number' && Number.isFinite(loc.lon) && Math.abs(loc.lon) <= 180) next.lon = loc.lon;
      out.location = next;
    }

    const info = incoming.importantInfo;
    if (info && typeof info === 'object') {
      const next = { ...current.importantInfo };
      if (typeof info.enabled === 'boolean') next.enabled = info.enabled;
      if (isStr(info.title)) next.title = info.title;
      if (isStr(info.message)) next.message = info.message;
      out.importantInfo = next;
    }

    // Which built-in widgets appear in the carousel
    const flags = incoming.widgets;
    if (flags && typeof flags === 'object') {
      const next = { ...current.widgets };
      for (const k of ['leaderboard', 'news', 'events', 'instagram', 'uniform', 'chainOfCommand']) {
        if (typeof flags[k] === 'boolean') next[k] = flags[k];
      }
      out.widgets = next;
    }

    // Small-screen layout: automatic detection, or forced either way
    if (['auto', 'full', 'compact'].includes(incoming.layout)) out.layout = incoming.layout;

    // Extra embed widgets: {id, name (shown on /edit), title (shown on the carousel), embedCode, enabled}
    if (Array.isArray(incoming.customWidgets)) {
      const seen = new Set();
      out.customWidgets = incoming.customWidgets
        .filter(w => w && typeof w === 'object')
        .slice(0, 20)
        .map(w => {
          let id = isStr(w.id) && /^[A-Za-z0-9_-]{1,40}$/.test(w.id) ? w.id : null;
          if (!id || seen.has(id)) id = 'w' + crypto.randomBytes(4).toString('hex');
          seen.add(id);
          return {
            id,
            name: String(w.name ?? '').slice(0, 80),
            title: String(w.title ?? '').slice(0, 80),
            embedCode: String(w.embedCode ?? '').slice(0, 20000),
            enabled: w.enabled !== false
          };
        });
    }

    if (Array.isArray(incoming.events)) {
      out.events = incoming.events
        .filter(e => e && typeof e === 'object')
        .map(e => ({
          title: String(e.title ?? ''), date: String(e.date ?? ''), detail: String(e.detail ?? ''),
          // optional YYYY-MM-DD: the event is hidden from the display the day after this
          hideAfter: isStr(e.hideAfter) && DATE_KEY.test(e.hideAfter.trim()) ? e.hideAfter.trim() : ''
        }));
    }

    // Uniform panel: manual entries (date + uniform), used alongside "Uniform:" lines found in calendar events
    if (incoming.uniform && typeof incoming.uniform === 'object' && Array.isArray(incoming.uniform.items)) {
      out.uniform = {
        ...current.uniform,
        items: incoming.uniform.items
          .filter(i => i && typeof i === 'object' && isStr(i.date) && DATE_KEY.test(i.date.trim()) && String(i.uniform ?? '').trim())
          .slice(0, 40)
          .map(i => ({ date: i.date.trim(), title: String(i.title ?? '').slice(0, 80), uniform: String(i.uniform).trim().slice(0, 80) }))
      };
    }

    // Chain of Command: people hierarchy with rank, name, optional photo (base64), reportsTo id
    if (incoming.chainOfCommand && typeof incoming.chainOfCommand === 'object' && Array.isArray(incoming.chainOfCommand.people)) {
      const RANK_RE = /^[A-Za-z0-9 /()_-]{1,40}$/;
      const seenIds = new Set();
      out.chainOfCommand = {
        people: incoming.chainOfCommand.people
          .filter(p => p && typeof p === 'object')
          .slice(0, 40)
          .map(p => {
            let id = isStr(p.id) && /^[A-Za-z0-9_-]{1,40}$/.test(p.id) ? p.id : null;
            if (!id || seenIds.has(id)) id = 'p' + crypto.randomBytes(4).toString('hex');
            seenIds.add(id);
            let photo = '';
            if (isStr(p.photo) && p.photo.startsWith('data:image/') && p.photo.length <= 120000) {
              photo = p.photo;
            }
            let color = '';
            if (isStr(p.color) && /^#[0-9A-Fa-f]{6}$/.test(p.color.trim())) color = p.color.trim().toUpperCase();
            return {
              id,
              rank: isStr(p.rank) && RANK_RE.test(p.rank.trim()) ? p.rank.trim() : '',
              name: String(p.name ?? '').slice(0, 80).trim(),
              photo,
              color,
              reportsTo: isStr(p.reportsTo) && /^[A-Za-z0-9_-]{1,40}$/.test(p.reportsTo) ? p.reportsTo : ''
            };
          })
          .filter(p => p.name) // must have a name
      };
    }
    // Branding: custom loading logo (data URL; transparent PNG recommended)
    if (incoming.branding && typeof incoming.branding === 'object') {
      const next = { ...(current.branding || { loadingLogo: '' }) };
      if (typeof incoming.branding.loadingLogo === 'string') {
        const logo = incoming.branding.loadingLogo;
        if (!logo) next.loadingLogo = '';
        else if (logo.startsWith('data:image/') && logo.length <= 1_500_000) next.loadingLogo = logo;
      }
      out.branding = { loadingLogo: next.loadingLogo || '' };
    }
    return out;
  }

  // A complete settings object made only from the built-in defaults (used when importing a config file)
  const defaultData = () => withDefaults({});
  return { load, save, sanitize, defaultData, dataFile, backupFile };
}

module.exports = { createStore, writeFileDurable, isHttpUrl, isValidTimeZone };
