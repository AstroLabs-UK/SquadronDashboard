// Fetches and caches the squadron calendar.
//
// Any number of calendar accounts can be linked at once (see lib/accounts.js):
//   google / outlook / ics - a secret .ics link
//   timetree               - email + password stored in settings; we log in, pull the chosen
//                            calendar, and turn it into the same event list
//
// Every enabled account is fetched (and cached) on its own, then the events are merged into one list.
// If one account is down the others still show. Results are cached for 10 minutes; if a refresh
// fails the last good copy is kept for up to 24 hours (stale: true).
const { parseCalendar } = require('./ics');
const { createCache } = require('./cache');
const { isValidTz } = require('./tz');
const timetree = require('./timetree');
const accountsLib = require('./accounts');

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

  async function loadTimetree(a, tz, days, key) {
    const failed = failures.get(key);
    if (failed && now() - failed.at < RETRY_AFTER_MS) throw failed.error;
    try {
      const result = await timetree.exportIcs({
        email: a.email,
        password: a.password,
        calendarId: a.calendarId,
        calendarCode: a.calendarCode,
        labelIds: Array.isArray(a.labelIds) ? a.labelIds : []
      });
      const events = parseCalendar(result.ics, { now: now(), days: Math.max(days, 14), tz });
      failures.delete(key);
      return events;
    } catch (e) {
      failures.set(key, { at: now(), error: e });
      throw e;
    }
  }

  // Same event in two accounts (a shared calendar, or Google + TimeTree copies) is shown once,
  // keeping whichever copy has a description / link.
  function mergeEvents(lists) {
    const seen = new Map();
    const out = [];
    for (const list of lists) {
      for (const e of list) {
        const key = [e.allDay ? 1 : 0, e.start, e.end, String(e.title || '').trim().toLowerCase()].join('|');
        const hit = seen.get(key);
        if (hit) {
          if (!hit.url && e.url) hit.url = e.url;
          if (!hit.description && e.description) hit.description = e.description;
          if (!hit.location && e.location) hit.location = e.location;
          for (const c of e.categories || []) if (!hit.categories.includes(c)) hit.categories.push(c);
          continue;
        }
        const copy = { ...e, categories: [...(e.categories || [])] };
        seen.set(key, copy);
        out.push(copy);
      }
    }
    return out.sort((x, y) => x.start - y.start || String(x.title).localeCompare(String(y.title)));
  }

  // -> { configured, events, ok, stale, updatedAt, error?, source, accounts: [{ id, type, name, ok, ... }] }
  async function get() {
    const s = store.load();
    const tz = isValidTz(s.calendarTimezone) ? s.calendarTimezone : 'Europe/London';
    const days = Math.min(365, Math.max(14, parseInt(s.calendarDays, 10) || 60));

    const all = accountsLib.resolveAccounts(s);
    const active = all.filter(a => a.enabled !== false && accountsLib.isComplete(a));
    const filterOn = accountsLib.tagFilterActive(active);
    const source = active.length > 1 ? 'multi'
      : active.length === 1 ? (active[0].type === 'timetree' ? 'timetree' : 'ics')
      : (s.calendarSource === 'timetree' ? 'timetree' : 'ics');

    if (!active.length) {
      return { configured: false, events: [], ok: true, stale: false, updatedAt: null, tz, source, accounts: [] };
    }

    const results = await Promise.all(active.map(async a => {
      const info = { id: a.id, type: a.type, name: a.name };
      try {
        if (a.type === 'timetree') {
          const labelIds = Array.isArray(a.labelIds) ? a.labelIds : [];
          // Tags are one merged menu: once any tag is ticked, an account with none of the ticked tags shows nothing
          if (filterOn && !labelIds.length) return { ...info, ok: true, stale: false, updatedAt: null, events: [] };
          const key = 'timetree|' + a.id + '|' + String(a.email).trim() + '|' + (a.calendarId || '') + '|' + labelIds.join(',') + '|' + tz + '|' + days;
          const { value, stale, updatedAt } = await cache.get(key, () => loadTimetree(a, tz, days, key));
          return { ...info, ok: true, stale, updatedAt, events: value };
        }
        const url = normalizeIcsUrl(a.url);
        const { value, stale, updatedAt } = await cache.get(url + '|' + tz + '|' + days, () => loadIcs(url, tz, days));
        return { ...info, ok: true, stale, updatedAt, events: value };
      } catch (e) {
        return { ...info, ok: false, stale: false, updatedAt: null, events: [], error: friendlyError(e) };
      }
    }));

    const good = results.filter(r => r.ok);
    const bad = results.filter(r => !r.ok);
    const label = r => (active.length > 1 ? r.name + ': ' : '') + r.error;
    const updated = good.map(r => r.updatedAt).filter(Boolean);
    return {
      configured: true,
      events: mergeEvents(good.map(r => r.events)),
      ok: good.length > 0,
      stale: good.some(r => r.stale),
      updatedAt: updated.length ? Math.max(...updated) : null,
      tz,
      source,
      ...(bad.length ? { error: bad.map(label).join(' | ') } : {}),
      accounts: results.map(r => ({
        id: r.id, type: r.type, name: r.name, ok: r.ok, stale: r.stale,
        events: r.events.length, ...(r.error ? { error: r.error } : {})
      }))
    };
  }

  return { get, clear: () => cache.clear() };
}

module.exports = { createCalendarService, normalizeIcsUrl, friendlyError };
