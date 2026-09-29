// Calendar accounts: several calendars can be linked at the same time and their events are merged.
//
// Each account is one of:
//   google   - Google Calendar "secret address in iCal format"
//   outlook  - Outlook / Microsoft 365 published calendar (.ics link)
//   ics      - any other .ics / webcal link (iCloud etc.); also what old single-link setups become
//   timetree - TimeTree login (email + password), one calendar picked from that login
//
// Settings saved before this feature existed have no `calendarAccounts` list. Those are turned
// into accounts on the fly (resolveAccounts) so nothing has to be re-entered. The list is only
// written to disk once /edit saves it.
const crypto = require('crypto');

const TYPES = ['google', 'outlook', 'timetree', 'ics'];
const LINK_TYPES = ['google', 'outlook', 'ics'];
const MAX_ACCOUNTS = 12;
const MASK = '********';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
}

function cleanUrl(v) {
  const s = String(v == null ? '' : v).trim().replace(/^webcal:\/\//i, 'https://');
  return s === '' || isHttpUrl(s) ? s : null; // null = invalid
}

const numList = (arr, max) => (Array.isArray(arr) ? arr : [])
  .map(Number).filter(n => Number.isFinite(n)).slice(0, max);

function cleanLabels(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(l => l && l.id != null && Number.isFinite(Number(l.id)))
    .slice(0, 40)
    .map(l => ({
      id: Number(l.id),
      name: String(l.name || ('Tag ' + l.id)).slice(0, 80),
      color: String(l.color || '').slice(0, 30)
    }));
}

function defaultName(type) {
  return { google: 'Google Calendar', outlook: 'Outlook Calendar', timetree: 'TimeTree', ics: 'Calendar link' }[type] || 'Calendar';
}

// Accounts derived from the old single-calendar settings (used until /edit saves a real list).
function legacyAccounts(s) {
  const out = [];
  const source = s && s.calendarSource === 'timetree' ? 'timetree' : 'ics';
  const url = cleanUrl(s && s.icsUrl);
  if (url) {
    out.push({ id: 'legacy-ics', type: 'ics', name: defaultName('ics'), enabled: source === 'ics', url });
  }
  const email = String((s && s.timetreeEmail) || '').trim();
  const password = String((s && s.timetreePassword) || '');
  if (email || password) {
    out.push({
      id: 'legacy-timetree', type: 'timetree', name: String((s && s.timetreeCalendarName) || defaultName('timetree')),
      enabled: source === 'timetree',
      email, password,
      calendarId: String((s && s.timetreeCalendarId) || ''),
      calendarName: String((s && s.timetreeCalendarName) || ''),
      calendarCode: String((s && s.timetreeCalendarCode) || ''),
      labelIds: numList(s && s.timetreeLabelIds, 20),
      uniformLabelIds: numList(s && s.timetreeUniformLabelIds, 20),
      labels: cleanLabels(s && s.timetreeLabels),
      labelsRefreshedAt: (s && Number(s.timetreeLabelsRefreshedAt)) || null
    });
  }
  return out;
}

function resolveAccounts(s) {
  if (s && Array.isArray(s.calendarAccounts)) return s.calendarAccounts;
  return legacyAccounts(s || {});
}

// An account is "complete" when it has what it needs to fetch events.
function isComplete(a) {
  if (!a) return false;
  if (a.type === 'timetree') return !!(String(a.email || '').trim() && String(a.password || ''));
  return !!cleanUrl(a.url);
}

// Validate an incoming list from /edit. `existing` lets a masked/blank password keep the saved one.
function sanitizeAccounts(incoming, existing) {
  const prev = new Map((Array.isArray(existing) ? existing : []).map(a => [a.id, a]));
  const seen = new Set();
  const out = [];
  for (const a of (Array.isArray(incoming) ? incoming : []).slice(0, MAX_ACCOUNTS)) {
    if (!a || typeof a !== 'object' || !TYPES.includes(a.type)) continue;
    let id = typeof a.id === 'string' && ID_RE.test(a.id) ? a.id : null;
    if (!id || seen.has(id)) id = 'a' + crypto.randomBytes(4).toString('hex');
    seen.add(id);
    const old = prev.get(id) && prev.get(id).type === a.type ? prev.get(id) : null;

    const acc = {
      id,
      type: a.type,
      name: String(a.name == null ? '' : a.name).trim().slice(0, 80) || defaultName(a.type),
      enabled: a.enabled !== false
    };

    if (a.type === 'timetree') {
      acc.email = String(a.email || '').trim().slice(0, 200);
      const pw = typeof a.password === 'string' ? a.password : '';
      acc.password = (pw && pw !== MASK) ? pw.slice(0, 200) : (old ? String(old.password || '') : '');
      acc.calendarId = String(a.calendarId == null ? '' : a.calendarId).trim().slice(0, 40);
      acc.calendarName = String(a.calendarName || '').trim().slice(0, 120);
      acc.calendarCode = String(a.calendarCode || '').trim().slice(0, 80);
      acc.labelIds = numList(a.labelIds, 20);
      acc.uniformLabelIds = numList(a.uniformLabelIds, 20);
      acc.labels = cleanLabels(a.labels);
      const t = Number(a.labelsRefreshedAt);
      acc.labelsRefreshedAt = Number.isFinite(t) && t > 0 ? t : (old && old.labelsRefreshedAt) || null;
    } else {
      const url = cleanUrl(a.url);
      acc.url = url === null ? (old ? String(old.url || '') : '') : url; // bad link: keep the saved one
    }
    out.push(acc);
  }
  return out;
}

// What /edit is allowed to see. Passwords are never sent back; the public display sees no secrets at all.
function maskAccounts(list, { editor }) {
  return (Array.isArray(list) ? list : []).map(a => {
    if (!editor) return { id: a.id, type: a.type, name: a.name, enabled: a.enabled !== false };
    const copy = { ...a };
    if (a.type === 'timetree') copy.password = a.password ? MASK : '';
    return copy;
  });
}

// One TimeTree tag can exist in several accounts under the same name. The merged menu on /edit and
// the uniform lookup both treat tags with the same name (ignoring case) as one tag.
function tagKey(name) { return String(name || '').trim().toLowerCase(); }

// Names of the tags ticked as "uniform" across every enabled TimeTree account.
function uniformTagNames(accounts) {
  const names = new Set();
  for (const a of accounts || []) {
    if (a.type !== 'timetree' || a.enabled === false) continue;
    const byId = new Map((a.labels || []).map(l => [Number(l.id), l.name]));
    for (const id of a.uniformLabelIds || []) {
      const n = byId.get(Number(id));
      if (n) names.add(tagKey(n));
    }
  }
  return [...names];
}

// True when any enabled TimeTree account has tags ticked. From then on only ticked tags are shown.
function tagFilterActive(accounts) {
  return (accounts || []).some(a => a.type === 'timetree' && a.enabled !== false && (a.labelIds || []).length > 0);
}

module.exports = {
  TYPES, LINK_TYPES, MAX_ACCOUNTS, MASK, ID_RE,
  cleanUrl, defaultName, legacyAccounts, resolveAccounts, isComplete,
  sanitizeAccounts, maskAccounts, tagKey, uniformTagNames, tagFilterActive
};
