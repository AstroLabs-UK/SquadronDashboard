const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUniform, extractUniform } = require('../lib/uniform');
const { buildEventList } = require('../lib/events');
const { normalizeIcsUrl } = require('../lib/calendar');

const TZ = 'Europe/London';
const NOW = Date.UTC(2026, 8, 23, 10, 0, 0); // Wed 23 Sep 2026 (this week = Mon 21 - Sun 27, next week = 28 Sep - 4 Oct)
const ce = (startKey, title, description = '', extra = {}) => ({ startKey, endKey: startKey, title, description, location: '', allDay: false, start: Date.UTC(+startKey.slice(0, 4), +startKey.slice(5, 7) - 1, +startKey.slice(8), 18), end: Date.UTC(+startKey.slice(0, 4), +startKey.slice(5, 7) - 1, +startKey.slice(8), 20), ...extra });

test('finds the uniform in the description or the title', () => {
  assert.equal(extractUniform({ description: 'Bring a pen\nUniform: Working blues\nThanks' }), 'Working blues');
  assert.equal(extractUniform({ description: 'uniform = No.1 (best)' }), 'No.1 (best)');
  assert.equal(extractUniform({ title: 'Parade [Uniform: PT kit]', description: '' }), 'PT kit');
  assert.equal(extractUniform({ title: 'Parade (uniform - Blues)', description: '' }), 'Blues');
  assert.equal(extractUniform({ title: 'Parade', description: 'Wear comfy uniform' }), null);
});

test('splits into this week (from today on) and next week, Monday to Sunday', () => {
  const u = buildUniform({ tz: TZ, now: NOW, manual: [], calendar: [
    ce('2026-09-21', 'Mon (passed)', 'Uniform: Old'),
    ce('2026-09-24', 'Parade Night', 'Uniform: Working blues'),
    ce('2026-09-27', 'Sunday event', 'Uniform: PT kit'),        // still this week
    ce('2026-09-28', 'Parade Night', 'Uniform: No.1s'),         // next Monday
    ce('2026-10-01', 'Parade Night', 'Uniform: Working blues'),
    ce('2026-10-05', 'Too far', 'Uniform: Nope'),
    ce('2026-09-30', 'No uniform mentioned', '')
  ] });
  assert.deepEqual(u.thisWeek.map(x => x.uniform), ['Working blues', 'PT kit']);
  assert.deepEqual(u.nextWeek.map(x => x.day + ' ' + x.uniform), ['Mon 28 Sep No.1s', 'Thu 1 Oct Working blues']);
  assert.equal(u.thisWeek[0].title, 'Parade Night');
});

test('typed entries are merged with calendar ones, duplicates removed, junk ignored', () => {
  const u = buildUniform({ tz: TZ, now: NOW,
    calendar: [ce('2026-10-01', 'Parade Night', 'Uniform: Working blues')],
    manual: [
      { date: '2026-10-01', title: 'Parade', uniform: 'working blues' },   // same day + uniform: shown once
      { date: '2026-10-03', title: 'Camp prep', uniform: 'Combats' },
      { date: 'soon', title: 'bad date', uniform: 'x' },
      { date: '2026-10-02', title: 'no uniform', uniform: '' }
    ] });
  assert.deepEqual(u.nextWeek.map(x => x.uniform), ['Working blues', 'Combats']);
});

test('nothing announced gives two empty lists', () => {
  assert.deepEqual(buildUniform({ tz: TZ, now: NOW, calendar: [], manual: [] }), { thisWeek: [], nextWeek: [] });
});

test('event list: typed first, calendar next; expired typed events and finished calendar events are hidden', () => {
  const finished = ce('2026-09-23', 'Finished', '', { start: Date.UTC(2026, 8, 23, 6), end: Date.UTC(2026, 8, 23, 8) });
  const list = buildEventList({ tz: TZ, now: NOW,
    manual: [{ title: 'Typed', date: 'Sat', detail: 'Hall' }, { title: 'Expired', date: '', detail: '', hideAfter: '2026-09-22' }, { title: 'Last day', date: '', detail: '', hideAfter: '2026-09-23' }],
    calendar: [finished, ce('2026-09-24', 'Parade Night [Uniform: Blues]', '', { location: 'Squadron HQ, 1 High Street' })] });
  assert.deepEqual(list.map(e => e.title), ['Typed', 'Last day', 'Parade Night']);
  const parade = list[2];
  assert.equal(parade.date, 'Thu 24 Sep');
  assert.equal(parade.detail, '19:00–21:00 · Squadron HQ, 1 High Street');
});

test('all-day multi-day events show a date range; the list is capped', () => {
  const camp = { title: 'Camp', description: '', location: '', allDay: true, startKey: '2026-10-03', endKey: '2026-10-04', start: 0, end: 0 };
  const [c] = buildEventList({ tz: TZ, now: NOW, manual: [], calendar: [camp] });
  assert.equal(c.date, 'Sat 3 Oct – Sun 4 Oct');
  assert.equal(c.detail, '');
  const many = Array.from({ length: 30 }, (_, i) => ce('2026-10-' + String(i % 28 + 1).padStart(2, '0'), 'E' + i));
  assert.equal(buildEventList({ tz: TZ, now: NOW, manual: [], calendar: many }).length, 9);
});

test('calendar links: webcal:// becomes https://, anything else is rejected', () => {
  assert.equal(normalizeIcsUrl(' webcal://calendar.google.com/x.ics '), 'https://calendar.google.com/x.ics');
  assert.equal(normalizeIcsUrl('https://calendar.google.com/x.ics'), 'https://calendar.google.com/x.ics');
  assert.equal(normalizeIcsUrl('file:///etc/passwd'), '');
  assert.equal(normalizeIcsUrl('javascript:alert(1)'), '');
  assert.equal(normalizeIcsUrl(''), '');
});

test('network errors are turned into plain English', () => {
  const { friendlyError } = require('../lib/calendar');
  assert.match(friendlyError(new TypeError('fetch failed')), /could not connect to the calendar/);
  const timeout = new Error('x'); timeout.name = 'TimeoutError';
  assert.match(friendlyError(timeout), /too long/);
  assert.equal(friendlyError(new Error('the calendar link returned HTTP 404')), 'the calendar link returned HTTP 404');
});

test('a broken calendar link is not hammered: one attempt per minute, then it recovers', async () => {
  const { createCalendarService } = require('../lib/calendar');
  let t = 1000000, hits = 0, healthy = false;
  const fetchImpl = async () => {
    hits++;
    if (!healthy) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20991231T100000Z\r\nDTEND:20991231T110000Z\r\nSUMMARY:Far\r\nEND:VEVENT\r\nEND:VCALENDAR' };
  };
  const store = { load: () => ({ icsUrl: 'https://example.com/x.ics', calendarTimezone: 'Europe/London', calendarDays: 30 }) };
  const svc = createCalendarService({ store, fetchImpl, now: () => t });
  for (let i = 0; i < 5; i++) { const r = await svc.get(); assert.equal(r.ok, false); assert.match(r.error, /HTTP 404/); }
  assert.equal(hits, 1, 'five requests inside a minute = one real attempt');
  t += 61000; healthy = true;
  const r = await svc.get();
  assert.equal(r.ok, true);
  assert.equal(hits, 2);
});
