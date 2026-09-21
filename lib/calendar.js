// Fetches and caches the squadron calendar (.ics link from Google Calendar, Outlook, iCloud...).
//
// In Google Calendar: Settings > (your calendar) > Integrate calendar > "Secret address in iCal
// format". Paste that link on /edit. Nothing to sign in to, no API keys. Google can take a few
// hours to reflect changes in that feed.
//
// The link is fetched at most every 10 minutes. If the calendar can't be reached, the last good copy
// is used for up to 24 hours, and the result says so (stale: true).
const { parseCalendar } = require('./ics');
const { createCache } = require('./cache');
const { isValidTz } = require('./tz');

const MAX_BYTES = 15 * 1024 * 1024;

// webcal:// is just https:// with a different name
function normalizeIcsUrl(url) {
  const v = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : '';
  } catch (e) { return ''; }
}

// Node's own network errors are terse ("fetch failed") - say something a person can act on
function friendlyError(e) {
  const msg = String(e && e.message ? e.message : e);
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'the calendar took too long to answer - try again in a minute';
  if (msg === 'fetch failed') return 'could not connect to the calendar - check the link and the internet connection';
  return msg;
}

function createCalendarService({ store, fetchImpl = fetch, now = Date.now, ttlMs = 10 * 60 * 1000 }) {
  const cache = createCache({ ttlMs, staleMs: 24 * 60 * 60 * 1000, now });

  // A broken link is not retried for a minute: the display asks every 10 seconds, and there's no
  // point hammering Google (or waiting on a timeout) each time.
  const failures = new Map();
  const RETRY_AFTER_MS = 60 * 1000;

  async function load(url, tz, days) {
    const failed = failures.get(url);
    if (failed && now() - failed.at < RETRY_AFTER_MS) throw failed.error;
    try {
      const events = await fetchAndParse(url, tz, days);
      failures.delete(url);
      return events;
    } catch (e) {
      failures.set(url, { at: now(), error: e });
      throw e;
    }
  }

  async function fetchAndParse(url, tz, days) {
    const r = await fetchImpl(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'text/calendar, */*', 'User-Agent': 'SquadronDashboard' }
    });
    if (!r.ok) throw new Error('the calendar link returned HTTP ' + r.status + ' - check it is the "secret address in iCal format"');
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (len > MAX_BYTES) throw new Error('the calendar file is too large');
    const text = await r.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('that link did not return a calendar (.ics) file');
    // at least 14 days so the uniform panel can always see next week
    return parseCalendar(text, { now: now(), days: Math.max(days, 14), tz });
  }

  // -> { configured, events, ok, stale, updatedAt, error? }
  async function get() {
    const s = store.load();
    const url = normalizeIcsUrl(s.icsUrl);
    const tz = isValidTz(s.calendarTimezone) ? s.calendarTimezone : 'Europe/London';
    const days = Math.min(365, Math.max(14, parseInt(s.calendarDays, 10) || 60));
    if (!url) return { configured: false, events: [], ok: true, stale: false, updatedAt: null, tz };
    try {
      const { value, stale, updatedAt } = await cache.get(url + '|' + tz + '|' + days, () => load(url, tz, days));
      return { configured: true, events: value, ok: true, stale, updatedAt, tz };
    } catch (e) {
      return { configured: true, events: [], ok: false, stale: false, updatedAt: null, tz, error: friendlyError(e) };
    }
  }

  return { get, clear: () => cache.clear() };
}

module.exports = { createCalendarService, normalizeIcsUrl, friendlyError };
