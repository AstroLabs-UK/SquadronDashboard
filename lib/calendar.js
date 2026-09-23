// Fetches and caches the squadron calendar.
//
// Two sources (chosen on /edit):
//   ics      — paste a Google / Outlook / iCloud secret .ics URL
//   timetree — email + password stored in settings; we log in to TimeTree, pull the
//              chosen calendar, and turn it into the same event list
//
// Either way the display sees the same shape of events. Results are cached for 10 minutes;
// if a refresh fails the last good copy is kept for up to 24 hours (stale: true).
const { parseCalendar } = require('./ics');
const { createCache } = require('./cache');
const { isValidTz } = require('./tz');
const timetree = require('./timetree');

const MAX_BYTES = 15 * 1024 * 1024;

function normalizeIcsUrl(url) {
  const v = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : '';
  } catch (e) { return ''; }
}

function friendlyError(e) {
  const msg = String(e && e.message ? e.message : e);
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return 'the calendar took too long to answer - try again in a minute';
  }
  if (msg === 'fetch failed') {
    return 'could not connect to the calendar - check the link and the internet connection';
  }
  return msg;
}

function createCalendarService({ store, fetchImpl = fetch, now = Date.now, ttlMs = 10 * 60 * 1000 }) {
  const cache = createCache({ ttlMs, staleMs: 24 * 60 * 60 * 1000, now });
  const failures = new Map();
  const RETRY_AFTER_MS = 60 * 1000;

  async function loadIcs(url, tz, days) {
    const failed = failures.get(url);
    if (failed && now() - failed.at < RETRY_AFTER_MS) throw failed.error;
    try {
      const events = await fetchAndParseIcs(url, tz, days);
      failures.delete(url);
      return events;
    } catch (e) {
      failures.set(url, { at: now(), error: e });
      throw e;
    }
  }

  async function fetchAndParseIcs(url, tz, days) {
    const r = await fetchImpl(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'text/calendar, */*', 'User-Agent': 'SquadronDashboard' }
    });
    if (!r.ok) {
      throw new Error('the calendar link returned HTTP ' + r.status + ' - check it is the "secret address in iCal format"');
    }
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (len > MAX_BYTES) throw new Error('the calendar file is too large');
    const text = await r.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('that link did not return a calendar (.ics) file');
    return parseCalendar(text, { now: now(), days: Math.max(days, 14), tz });
  }

  async function loadTimetree(s, tz, days) {
    const labelKey = (Array.isArray(s.timetreeLabelIds) ? s.timetreeLabelIds : []).join(',');
    const key = 'timetree|' + (s.timetreeEmail || '') + '|' + (s.timetreeCalendarId || '') + '|' + labelKey + '|' + tz + '|' + days;
    const failed = failures.get(key);
    if (failed && now() - failed.at < RETRY_AFTER_MS) throw failed.error;
    try {
      const labelIds = Array.isArray(s.timetreeLabelIds) ? s.timetreeLabelIds : [];
      const result = await timetree.exportIcs({
        email: s.timetreeEmail,
        password: s.timetreePassword,
        calendarId: s.timetreeCalendarId,
        calendarCode: s.timetreeCalendarCode,
        labelIds
      });
      const events = parseCalendar(result.ics, { now: now(), days: Math.max(days, 14), tz });
      failures.delete(key);
      return events;
    } catch (e) {
      failures.set(key, { at: now(), error: e });
      throw e;
    }
  }

  // -> { configured, events, ok, stale, updatedAt, error?, source? }
  async function get() {
    const s = store.load();
    const tz = isValidTz(s.calendarTimezone) ? s.calendarTimezone : 'Europe/London';
    const days = Math.min(365, Math.max(14, parseInt(s.calendarDays, 10) || 60));
    const source = s.calendarSource === 'timetree' ? 'timetree' : 'ics';

    if (source === 'timetree') {
      const email = String(s.timetreeEmail || '').trim();
      const password = String(s.timetreePassword || '');
      if (!email || !password) {
        return { configured: false, events: [], ok: true, stale: false, updatedAt: null, tz, source };
      }
      const labelKey = (Array.isArray(s.timetreeLabelIds) ? s.timetreeLabelIds : []).join(',');
      const cacheKey = 'timetree|' + email + '|' + (s.timetreeCalendarId || '') + '|' + labelKey + '|' + tz + '|' + days;
      try {
        const { value, stale, updatedAt } = await cache.get(cacheKey, () => loadTimetree(s, tz, days));
        return { configured: true, events: value, ok: true, stale, updatedAt, tz, source };
      } catch (e) {
        return { configured: true, events: [], ok: false, stale: false, updatedAt: null, tz, source, error: friendlyError(e) };
      }
    }

    // ICS import
    const url = normalizeIcsUrl(s.icsUrl);
    if (!url) return { configured: false, events: [], ok: true, stale: false, updatedAt: null, tz, source };
    try {
      const { value, stale, updatedAt } = await cache.get(url + '|' + tz + '|' + days, () => loadIcs(url, tz, days));
      return { configured: true, events: value, ok: true, stale, updatedAt, tz, source };
    } catch (e) {
      return { configured: true, events: [], ok: false, stale: false, updatedAt: null, tz, source, error: friendlyError(e) };
    }
  }

  return { get, clear: () => cache.clear() };
}

module.exports = { createCalendarService, normalizeIcsUrl, friendlyError };
