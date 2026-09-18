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

function createStore({ dir, defaults, legacyDir }) {
  const dataFile = path.join(dir, 'data.json');
  const backupFile = path.join(dir, 'data.backup.json');
  fs.mkdirSync(dir, { recursive: true });

  function withDefaults(d) {
    return {
      ...defaults,
      ...d,
      location: { ...defaults.location, ...(d.location && typeof d.location === 'object' ? d.location : {}) },
      importantInfo: { ...defaults.importantInfo, ...(d.importantInfo && typeof d.importantInfo === 'object' ? d.importantInfo : {}) },
      events: Array.isArray(d.events) ? d.events : defaults.events
    };
  }

  function save(data) {
    const json = JSON.stringify(data, null, 2);
    writeFileDurable(dataFile, json);
    writeFileDurable(backupFile, json);
  }

  function load() {
    try {
      return withDefaults(readJsonObject(dataFile));
    } catch (e) {
      console.warn('[storage] data.json missing or corrupt (' + e.message + ') - trying backup');
      try {
        const parsed = readJsonObject(backupFile); // validate before trusting it
        try { writeFileDurable(dataFile, JSON.stringify(parsed, null, 2)); } catch (e3) { /* best effort */ }
        console.warn('[storage] restored data.json from backup');
        return withDefaults(parsed);
      } catch (e2) {
        console.warn('[storage] backup also missing or corrupt (' + e2.message + ') - using built-in defaults');
        const fresh = withDefaults({});
        try { save(fresh); } catch (e4) { /* still serve defaults */ }
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
    for (const k of ['leaderboardCsvUrl', 'eventsSeeMoreUrl', 'errorReportUrl', 'instagramEmbedCode', 'weatherEmbedCode']) {
      if (isStr(incoming[k])) out[k] = incoming[k];
    }
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

    if (Array.isArray(incoming.events)) {
      out.events = incoming.events
        .filter(e => e && typeof e === 'object')
        .map(e => ({ title: String(e.title ?? ''), date: String(e.date ?? ''), detail: String(e.detail ?? '') }));
    }
    return out;
  }

  return { load, save, sanitize, dataFile, backupFile };
}

module.exports = { createStore, writeFileDurable };
