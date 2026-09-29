// Turns calendar events (from lib/ics.js) and hand-typed events into the list the display shows.
// Every item has the same shape: { title, date, detail, source } - so the display needs no changes
// to show a mix of both.
const { dateKey, dayLabel, timeLabel, DAY } = require('./tz');

const UNIFORM_TAG = /\s*[\[(]\s*uniform\s*[:=-][^\])]*[\])]/ig;
const HOUR = 60 * 60 * 1000;

function upcoming(calendarEvents, { tz, now }) {
  const today = dateKey(now, tz);
  return calendarEvents.filter(e => {
    if (e.allDay) return e.endKey >= today;
    const end = e.end > e.start ? e.end : e.start + 2 * HOUR;
    return end > now;
  });
}

// The event's note/description as one short line for the display. "Uniform: ..." lines feed the uniform
// panel instead, and the link that becomes the QR code is left out (it can't be read off a wall screen).
const DESC_MAX = 140;
function shortDescription(text, url) {
  let t = String(text || '');
  if (url) t = t.split(url).join(' ');
  t = t.split(/\r?\n/)
    .filter(line => !/^\s*uniform\s*[:=]/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > DESC_MAX ? t.slice(0, DESC_MAX - 1).trimEnd() + '…' : t;
}

function shapeCalendarEvent(e, tz) {
  const title = (e.title || 'Untitled event').replace(UNIFORM_TAG, '').trim() || 'Untitled event';
  let date = dayLabel(e.startKey);
  if (e.endKey && e.endKey > e.startKey) date += ' – ' + dayLabel(e.endKey);
  const parts = [];
  if (e.allDay) {
    if (e.endKey <= e.startKey) parts.push('All day');
  } else {
    const s = timeLabel(e.start, tz);
    if (e.end > e.start && dateKey(e.end - 1, tz) === e.startKey) parts.push(s + '–' + timeLabel(e.end, tz));
    else parts.push(s);
  }
  const loc = (e.location || '').trim();
  if (loc) parts.push(loc.length > 60 ? loc.slice(0, 57).trimEnd() + '…' : loc);
  const url = String(e.url || '').trim();
  return {
    title, date, detail: parts.join(' · '), source: 'calendar', start: e.start,
    description: shortDescription(e.description, url),
    // the event's own link (TimeTree link / URL field); the display turns it into a QR code
    url,
    categories: e.categories || [], startKey: e.startKey
  };
}

function activeManual(events, todayKey) {
  return (Array.isArray(events) ? events : []).filter(e => !(e && e.hideAfter && e.hideAfter < todayKey));
}

function buildEventList({ manual, calendar, tz, now, limit = 9 }) {
  const today = dateKey(now, tz);
  const typed = activeManual(manual, today).map(e => ({
    title: String(e.title || ''),
    date: String(e.date || ''),
    detail: String(e.detail || ''),
    description: '',
    url: String(e.url || '').trim(),
    source: 'manual'
  }));
  const room = Math.max(0, limit - typed.length);
  const cal = upcoming(calendar || [], { tz, now }).slice(0, room).map(e => shapeCalendarEvent(e, tz));
  return typed.concat(cal);
}

module.exports = { shortDescription, buildEventList, upcoming, shapeCalendarEvent, activeManual, UNIFORM_TAG, DAY };
