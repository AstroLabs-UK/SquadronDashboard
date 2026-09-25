const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCalendar, parseRrule, plainText } = require('../lib/ics');
const tzlib = require('../lib/tz');

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0); // Sun 20 Sep 2026, noon UTC (BST in the UK)
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const parse = (text, opts = {}) => parseCalendar(text, { now: NOW, days: 90, tz: 'Europe/London', ...opts });
const iso = ms => new Date(ms).toISOString().slice(0, 16) + 'Z';

test('time zone helpers: London is UTC+1 in summer, UTC+0 in winter', () => {
  assert.equal(iso(tzlib.wallToInstant(Date.UTC(2026, 8, 24, 19, 0), 'Europe/London')), '2026-09-24T18:00Z');
  assert.equal(iso(tzlib.wallToInstant(Date.UTC(2026, 10, 26, 19, 0), 'Europe/London')), '2026-11-26T19:00Z');
  assert.equal(tzlib.dayLabel('2026-09-24'), 'Thu 24 Sep');
  assert.equal(tzlib.mondayKey('2026-09-27'), '2026-09-21'); // a Sunday belongs to the week starting Monday 21st
  assert.equal(tzlib.mondayKey('2026-09-21'), '2026-09-21');
});

test('a single event in UTC (how Google exports most events)', () => {
  const [e] = parse(cal(ev('UID:1', 'DTSTART:20260924T180000Z', 'DTEND:20260924T200000Z', 'SUMMARY:Parade Night', 'LOCATION:Squadron HQ')));
  assert.equal(e.title, 'Parade Night');
  assert.equal(iso(e.start), '2026-09-24T18:00Z');
  assert.equal(iso(e.end), '2026-09-24T20:00Z');
  assert.equal(e.startKey, '2026-09-24');
  assert.equal(e.location, 'Squadron HQ');
  assert.equal(e.allDay, false);
});

test('an event with a named time zone', () => {
  const [e] = parse(cal(ev('UID:1', 'DTSTART;TZID=Europe/London:20260924T190000', 'DTEND;TZID=Europe/London:20260924T210000', 'SUMMARY:Drill')));
  assert.equal(iso(e.start), '2026-09-24T18:00Z');
});

test('a late-evening UK event lands on the right UK date', () => {
  const [e] = parse(cal(ev('UID:1', 'DTSTART:20260924T223000Z', 'DTEND:20260924T233000Z', 'SUMMARY:Night exercise')));
  assert.equal(e.startKey, '2026-09-24');
  const [f] = parse(cal(ev('UID:2', 'DTSTART:20260924T233000Z', 'DTEND:20260925T003000Z', 'SUMMARY:After midnight')));
  assert.equal(f.startKey, '2026-09-25'); // 00:30 BST the next day
});

test('all-day, multi-day events (camp)', () => {
  const [e] = parse(cal(ev('UID:c', 'DTSTART;VALUE=DATE:20261003', 'DTEND;VALUE=DATE:20261005', 'SUMMARY:Camp')));
  assert.equal(e.allDay, true);
  assert.equal(e.startKey, '2026-10-03');
  assert.equal(e.endKey, '2026-10-04'); // DTEND is exclusive in the file
});

test('weekly Thursday 19:00 stays 19:00 when the clocks change', () => {
  const text = cal(ev('UID:w', 'DTSTART;TZID=Europe/London:20260903T190000', 'DTEND;TZID=Europe/London:20260903T210000',
    'RRULE:FREQ=WEEKLY;BYDAY=TH', 'SUMMARY:Parade Night'));
  const list = parse(text, { now: Date.UTC(2026, 9, 20), days: 25 }); // clocks go back on Sun 25 Oct 2026
  const starts = list.map(e => iso(e.start));
  assert.deepEqual(starts, ['2026-10-22T18:00Z', '2026-10-29T19:00Z', '2026-11-05T19:00Z', '2026-11-12T19:00Z']);
});

test('EXDATE skips a date, a moved occurrence replaces it, a cancelled one disappears', () => {
  const text = cal(
    ev('UID:w', 'DTSTART;TZID=Europe/London:20260903T190000', 'DTEND;TZID=Europe/London:20260903T210000',
      'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=8', 'EXDATE;TZID=Europe/London:20260924T190000', 'SUMMARY:Parade'),
    ev('UID:w', 'RECURRENCE-ID;TZID=Europe/London:20261001T190000', 'DTSTART;TZID=Europe/London:20261002T100000',
      'DTEND;TZID=Europe/London:20261002T120000', 'SUMMARY:Parade (moved)'),
    ev('UID:w', 'RECURRENCE-ID;TZID=Europe/London:20261008T190000', 'DTSTART;TZID=Europe/London:20261008T190000',
      'STATUS:CANCELLED', 'SUMMARY:Parade')
  );
  const list = parse(text, { now: Date.UTC(2026, 8, 20), days: 60 });
  assert.deepEqual(list.map(e => e.startKey + ' ' + e.title), [
    '2026-10-02 Parade (moved)', '2026-10-15 Parade', '2026-10-22 Parade'
  ]); // 8 repeats from 3 Sep: 24 Sep skipped, 1 Oct moved to 2 Oct, 8 Oct cancelled
});

test('COUNT stops a repeat, and UNTIL does too', () => {
  const counted = parse(cal(ev('UID:a', 'DTSTART:20260901T180000Z', 'DTEND:20260901T190000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:X')), { now: Date.UTC(2026, 8, 1), days: 30 });
  assert.equal(counted.length, 3);
  const until = parse(cal(ev('UID:b', 'DTSTART:20260901T180000Z', 'DTEND:20260901T190000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20260915T180000Z', 'SUMMARY:X')), { now: Date.UTC(2026, 8, 1), days: 60 });
  assert.deepEqual(until.map(e => e.startKey), ['2026-09-01', '2026-09-08', '2026-09-15']);
});

test('monthly on the first Thursday, and on the last Friday', () => {
  const first = parse(cal(ev('UID:m', 'DTSTART;TZID=Europe/London:20260903T190000', 'DTEND;TZID=Europe/London:20260903T210000', 'RRULE:FREQ=MONTHLY;BYDAY=1TH', 'SUMMARY:Committee')), { now: Date.UTC(2026, 8, 1), days: 100 });
  assert.deepEqual(first.map(e => e.startKey), ['2026-09-03', '2026-10-01', '2026-11-05', '2026-12-03']);
  const last = parse(cal(ev('UID:l', 'DTSTART;TZID=Europe/London:20260925T190000', 'DTEND;TZID=Europe/London:20260925T210000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Social')), { now: Date.UTC(2026, 8, 1), days: 90 });
  assert.deepEqual(last.map(e => e.startKey), ['2026-09-25', '2026-10-30', '2026-11-27']);
});

test('every second week (INTERVAL) and monthly by date', () => {
  const biweekly = parse(cal(ev('UID:i', 'DTSTART:20260903T180000Z', 'DTEND:20260903T200000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'SUMMARY:X')), { now: Date.UTC(2026, 8, 1), days: 50 });
  assert.deepEqual(biweekly.map(e => e.startKey), ['2026-09-03', '2026-09-17', '2026-10-01', '2026-10-15']);
  const monthly = parse(cal(ev('UID:d', 'DTSTART:20260115T180000Z', 'DTEND:20260115T190000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'SUMMARY:X')), { now: Date.UTC(2026, 8, 1), days: 80 });
  assert.deepEqual(monthly.map(e => e.startKey), ['2026-09-15', '2026-10-15', '2026-11-15']);
});

test('a yearly all-day event (birthday)', () => {
  const list = parse(cal(ev('UID:y', 'DTSTART;VALUE=DATE:20100925', 'RRULE:FREQ=YEARLY', 'SUMMARY:Squadron anniversary')), { now: Date.UTC(2026, 8, 20), days: 30 });
  assert.deepEqual(list.map(e => e.startKey), ['2026-09-25']);
});

test('old events and events far in the future are left out; cancelled events are skipped', () => {
  const list = parse(cal(
    ev('UID:1', 'DTSTART:20200101T100000Z', 'DTEND:20200101T110000Z', 'SUMMARY:Old'),
    ev('UID:2', 'DTSTART:20300101T100000Z', 'DTEND:20300101T110000Z', 'SUMMARY:Far'),
    ev('UID:3', 'DTSTART:20260925T100000Z', 'DTEND:20260925T110000Z', 'SUMMARY:Gone', 'STATUS:CANCELLED'),
    ev('UID:4', 'DTSTART:20260926T100000Z', 'DTEND:20260926T110000Z', 'SUMMARY:Keep')));
  assert.deepEqual(list.map(e => e.title), ['Keep']);
});

test('folded lines, escaped characters and HTML descriptions are cleaned up', () => {
  const text = cal(ev('UID:1', 'DTSTART:20260924T180000Z', 'DTEND:20260924T200000Z',
    'SUMMARY:Parade\\, with a very long title that has been fol', ' ded across lines',
    'DESCRIPTION:Uniform: Working blues<br>Bring a pen\\nBe on time &amp; ready',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM'));
  const [e] = parse(text);
  assert.equal(e.title, 'Parade, with a very long title that has been folded across lines');
  assert.equal(e.description, 'Uniform: Working blues\nBring a pen\nBe on time & ready');
});

test('durations, and events with no end time', () => {
  const [a] = parse(cal(ev('UID:1', 'DTSTART:20260924T180000Z', 'DURATION:PT90M', 'SUMMARY:A')));
  assert.equal(iso(a.end), '2026-09-24T19:30Z');
  const [b] = parse(cal(ev('UID:2', 'DTSTART:20260924T180000Z', 'SUMMARY:B')));
  assert.equal(b.end, b.start);
});

test('garbage in gives an empty list, not a crash', () => {
  assert.deepEqual(parse('not a calendar'), []);
  assert.deepEqual(parse(cal(ev('UID:1', 'DTSTART:banana', 'SUMMARY:X'))), []);
  assert.equal(parseRrule('FREQ=SECONDLY'), null);
  assert.equal(plainText('a &lt;b&gt;'), 'a <b>');
});

test('an unknown time zone name falls back to the calendar zone instead of failing', () => {
  const [e] = parse(cal(ev('UID:1', 'DTSTART;TZID=GMT Standard Time:20260924T190000', 'DTEND;TZID=GMT Standard Time:20260924T210000', 'SUMMARY:X')));
  assert.equal(iso(e.start), '2026-09-24T18:00Z');
});
