// Minimal TimeTree web API client (login → calendars → labels → events → ICS).
// Adapted from https://github.com/mr-onadasky/timetree-live-ics (MIT).
// Events carry label_id; labels are listed via GET /calendar/{id}/labels.
const crypto = require('crypto');

const API_BASE = 'https://timetreeapp.com/api/v1';
const UA = 'web/2.1.0/en';
const TIMEOUT_MS = 15000;

function headers(sessionId) {
  const h = { 'Content-Type': 'application/json', 'X-Timetreea': UA };
  if (sessionId) h.Cookie = '_session_id=' + sessionId;
  return h;
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    let data;
    try { data = await r.json(); } catch (e) { data = undefined; }
    return { response: r, data };
  } finally {
    clearTimeout(t);
  }
}

async function login(email, password) {
  const payload = {
    uid: String(email || '').trim(),
    password: String(password || ''),
    uuid: crypto.randomUUID().replace(/-/g, '')
  };
  if (!payload.uid || !payload.password) throw new Error('email and password are required');

  const { response, data } = await fetchJson(API_BASE + '/auth/email/signin', {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = data && typeof data === 'object' ? JSON.stringify(data) : String(data || '');
    if (response.status === 401 || response.status === 403) {
      throw new Error('TimeTree login failed — check email and password');
    }
    throw new Error('TimeTree login failed (HTTP ' + response.status + ')' + (detail ? ': ' + detail.slice(0, 120) : ''));
  }

  let setCookie = '';
  if (typeof response.headers.getSetCookie === 'function') {
    setCookie = (response.headers.getSetCookie() || []).join('; ');
  } else {
    setCookie = response.headers.get('set-cookie') || '';
  }
  const m = /_session_id=([^;,\s]+)/.exec(setCookie);
  if (!m) throw new Error('TimeTree login succeeded but no session cookie was returned');
  return m[1];
}

async function fetchCalendars(sessionId) {
  const { response, data } = await fetchJson(API_BASE + '/calendars?since=0', {
    method: 'GET',
    headers: headers(sessionId)
  });
  if (!response.ok) throw new Error('Could not list TimeTree calendars (HTTP ' + response.status + ')');
  const list = Array.isArray(data && data.calendars) ? data.calendars : [];
  return list
    .filter(c => c && c.deactivated_at == null)
    .map(c => ({
      id: c.id,
      name: String(c.name || 'Calendar'),
      code: String(c.alias_code || '')
    }));
}

// Labels (colour tags) for a calendar — name is user-customisable in TimeTree.
async function fetchLabels(sessionId, calendarId) {
  const { response, data } = await fetchJson(API_BASE + '/calendar/' + calendarId + '/labels', {
    method: 'GET',
    headers: headers(sessionId)
  });
  if (!response.ok) throw new Error('Could not list TimeTree labels (HTTP ' + response.status + ')');
  const list = Array.isArray(data && data.calendar_labels) ? data.calendar_labels
    : Array.isArray(data && data.labels) ? data.labels : [];
  return list.map(l => ({
    id: Number(l.id),
    name: String(l.name || ('Label ' + l.id)),
    color: l.color || l.default_color || '',
    order: typeof l.order === 'number' ? l.order : 0
  })).sort((a, b) => a.order - b.order || a.id - b.id);
}

async function fetchEventsChunk(sessionId, calendarId, since) {
  const url = since != null
    ? API_BASE + '/calendar/' + calendarId + '/events/sync?since=' + since
    : API_BASE + '/calendar/' + calendarId + '/events/sync';
  const { response, data } = await fetchJson(url, { method: 'GET', headers: headers(sessionId) });
  if (!response.ok) {
    throw new Error('Could not fetch TimeTree events (HTTP ' + response.status + ')');
  }
  const events = Array.isArray(data && data.events) ? data.events : [];
  if (data && data.chunk === true && typeof data.since === 'number') {
    return events.concat(await fetchEventsChunk(sessionId, calendarId, data.since));
  }
  return events;
}

async function fetchEvents(sessionId, calendarId) {
  return fetchEventsChunk(sessionId, calendarId);
}

function escapeText(s) {
  if (!s) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function foldLine(line) {
  const max = 75;
  if (line.length <= max) return line;
  let out = line.slice(0, max);
  let rest = line.slice(max);
  while (rest.length) {
    out += '\r\n ' + rest.slice(0, max - 1);
    rest = rest.slice(max - 1);
  }
  return out;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function formatUtc(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

function formatDate(ms, zoneHint) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zoneHint || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return fmt.format(new Date(ms)).replace(/-/g, '');
  } catch (e) {
    const d = new Date(ms);
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  }
}

function eventToLines(ev, labelName) {
  if (ev.type === 1 || ev.category === 2) return null; // skip birthdays / memos
  if (!ev.title && !ev.note) return null;

  const lines = ['BEGIN:VEVENT'];
  lines.push('UID:' + (ev.uuid || ('tt-' + ev.created_at + '@timetree')));
  lines.push('SUMMARY:' + escapeText(ev.title || 'Untitled'));
  if (ev.note) lines.push('DESCRIPTION:' + escapeText(ev.note));
  if (ev.location) lines.push('LOCATION:' + escapeText(ev.location));
  if (ev.url) lines.push('URL:' + escapeText(ev.url));
  if (labelName) lines.push('CATEGORIES:' + escapeText(labelName));

  if (ev.all_day) {
    const start = formatDate(ev.start_at, ev.start_timezone);
    let endMs = ev.end_at;
    if (endMs <= ev.start_at) endMs = ev.start_at + 86400000;
    const end = formatDate(endMs, ev.end_timezone || ev.start_timezone);
    lines.push('DTSTART;VALUE=DATE:' + start);
    lines.push('DTEND;VALUE=DATE:' + end);
  } else {
    lines.push('DTSTART:' + formatUtc(ev.start_at));
    lines.push('DTEND:' + formatUtc(ev.end_at > ev.start_at ? ev.end_at : ev.start_at + 3600000));
  }

  if (Array.isArray(ev.recurrences)) {
    for (const r of ev.recurrences) {
      if (typeof r === 'string' && r.trim()) lines.push(r.trim());
    }
  }

  lines.push('END:VEVENT');
  return lines;
}

function buildICS(events, labelMap) {
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Squadron Dashboard TimeTree//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN'
  ];
  for (const ev of events || []) {
    const name = labelMap && ev.label_id != null ? labelMap[ev.label_id] : '';
    const el = eventToLines(ev, name);
    if (el) lines.push(...el);
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * @param {{ email, password, calendarId?, calendarCode?, labelIds? }} opts
 * labelIds: array of numeric label ids to include. Empty / missing = all labels.
 */
async function exportIcs(opts) {
  const sessionId = await login(opts.email, opts.password);
  const calendars = await fetchCalendars(sessionId);
  if (!calendars.length) throw new Error('No active TimeTree calendars on this account');

  let cal = null;
  if (opts.calendarId != null && opts.calendarId !== '') {
    const id = Number(opts.calendarId);
    cal = calendars.find(c => c.id === id) || null;
  }
  if (!cal && opts.calendarCode) {
    cal = calendars.find(c => c.code === opts.calendarCode) || null;
  }
  if (!cal) cal = calendars[0];

  const labels = await fetchLabels(sessionId, cal.id);
  const labelMap = {};
  for (const l of labels) labelMap[l.id] = l.name;

  let events = await fetchEvents(sessionId, cal.id);

  // Filter by selected tags when the user picked one or more
  const selected = Array.isArray(opts.labelIds)
    ? opts.labelIds.map(Number).filter(n => Number.isFinite(n))
    : [];
  if (selected.length > 0) {
    const want = new Set(selected);
    events = events.filter(e => want.has(Number(e.label_id)));
  }

  return {
    ics: buildICS(events, labelMap),
    calendar: cal,
    calendars,
    labels,
    eventCount: events.length
  };
}

module.exports = {
  login,
  fetchCalendars,
  fetchLabels,
  fetchEvents,
  buildICS,
  exportIcs
};
