// Linked calendar accounts: several calendars at once, merged into one list, one tag menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const accounts = require('../lib/accounts');
const { createCalendarService } = require('../lib/calendar');
const timetree = require('../lib/timetree');
const { parseCalendar } = require('../lib/ics');
const { shapeCalendarEvent, shortDescription } = require('../lib/events');
const { createStore } = require('../storage');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const ics = (...events) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.join('') + 'END:VCALENDAR\r\n';
const vevent = (uid, title, day, extra = '') =>
  'BEGIN:VEVENT\r\nUID:' + uid + '\r\nSUMMARY:' + title + '\r\nDTSTART:202610' + day + 'T180000Z\r\nDTEND:202610' + day + 'T200000Z\r\n' + extra + 'END:VEVENT\r\n';

test('old single-calendar settings become accounts, only the chosen source switched on', () => {
  const a = accounts.resolveAccounts({ icsUrl: 'https://x.test/a.ics', calendarSource: 'ics' });
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].type, a[0].enabled, a[0].url], ['ics', true, 'https://x.test/a.ics']);

  const b = accounts.resolveAccounts({ icsUrl: 'https://x.test/a.ics', calendarSource: 'timetree', timetreeEmail: 'a@b.c', timetreePassword: 'pw', timetreeCalendarId: '7', timetreeLabelIds: [3] });
  assert.equal(b.length, 2);
  assert.equal(b.find(x => x.type === 'ics').enabled, false);
  const tt = b.find(x => x.type === 'timetree');
  assert.deepEqual([tt.enabled, tt.calendarId, tt.labelIds], [true, '7', [3]]);

  assert.deepEqual(accounts.resolveAccounts({}), []);
});

test('sanitize: unknown types and bad links dropped, masked password keeps the saved one', () => {
  const existing = [{ id: 'tt1', type: 'timetree', name: 'TT', email: 'a@b.c', password: 'secret' },
                    { id: 'g1', type: 'google', name: 'G', url: 'https://good.test/g.ics' }];
  const out = accounts.sanitizeAccounts([
    { id: 'tt1', type: 'timetree', name: 'Squadron', email: 'a@b.c', password: '********', labelIds: ['5', 'x', 6] },
    { id: 'g1', type: 'google', name: 'G', url: 'javascript:alert(1)' },
    { id: 'bad id!', type: 'outlook', url: 'webcal://o.test/o.ics' },
    { id: 'n', type: 'nope' }
  ], existing);
  assert.equal(out.length, 3);
  assert.equal(out[0].password, 'secret');
  assert.deepEqual(out[0].labelIds, [5, 6]);
  assert.equal(out[1].url, 'https://good.test/g.ics'); // invalid link ignored, saved one kept
  assert.equal(out[2].url, 'https://o.test/o.ics');
  assert.match(out[2].id, /^a[0-9a-f]{8}$/);
});

test('the public display gets no accounts; the editor gets them with passwords masked', () => {
  const list = [{ id: 'tt1', type: 'timetree', name: 'TT', password: 'secret' }, { id: 'g', type: 'google', name: 'G', url: 'https://u.test/x.ics' }];
  const editor = accounts.maskAccounts(list, { editor: true });
  assert.equal(editor[0].password, '********');
  assert.equal(editor[1].url, 'https://u.test/x.ics');
  assert.ok(!('url' in accounts.maskAccounts(list, { editor: false })[1]));
});

test('saving accounts through the store keeps passwords and clears the old single-calendar secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-acc-'));
  const store = createStore({ dir, defaults: { location: {}, importantInfo: {}, widgets: {}, uniform: {}, events: [], customWidgets: [] } });
  const legacy = store.sanitize(store.load(), { timetreeEmail: 'a@b.c', timetreePassword: 'pw', calendarSource: 'timetree', icsUrl: 'https://x.test/a.ics' });
  store.save(legacy);
  // the editor sends back what it was given: the derived accounts, password masked
  const shown = accounts.maskAccounts(accounts.resolveAccounts(store.load()), { editor: true });
  store.save(store.sanitize(store.load(), { calendarAccounts: shown }));
  const after = store.load();
  assert.equal(after.timetreePassword, '');
  assert.equal(after.icsUrl, '');
  assert.equal(after.calendarAccounts.find(a => a.type === 'timetree').password, 'pw');
});

test('tag menu rules: filter is on when any tag is ticked; uniform tags are matched by name across accounts', () => {
  const list = [
    { type: 'timetree', enabled: true, labels: [{ id: 1, name: 'Uniform' }], uniformLabelIds: [1], labelIds: [] },
    { type: 'timetree', enabled: true, labels: [{ id: 9, name: 'Camps' }], uniformLabelIds: [], labelIds: [9] },
    { type: 'timetree', enabled: false, labels: [{ id: 2, name: 'Hidden' }], uniformLabelIds: [2], labelIds: [2] }
  ];
  assert.equal(accounts.tagFilterActive(list), true);
  assert.equal(accounts.tagFilterActive([list[0]]), false);
  assert.deepEqual(accounts.uniformTagNames(list), ['uniform']);
});

test('ics: the URL field and links in descriptions become the event link', () => {
  const feed = ics(
    vevent('1', 'Camp', '10', 'URL:https://forms.test/camp?a=1,2;b=3\r\nDESCRIPTION:Bring a sleeping bag\r\n'),
    vevent('2', 'Trip', '11', 'DESCRIPTION:Details at https://trip.test/info.\r\n'),
    vevent('3', 'Plain', '12', 'DESCRIPTION:No link here\r\n')
  );
  const ev = parseCalendar(feed, { now: NOW, days: 60, tz: 'Europe/London' });
  const by = t => ev.find(e => e.title === t);
  assert.equal(by('Camp').url, 'https://forms.test/camp?a=1,2;b=3');
  assert.equal(by('Trip').url, 'https://trip.test/info');
  assert.equal(by('Plain').url, '');
});

test('TimeTree export keeps the link intact and the note becomes the description', () => {
  const out = timetree.buildICS([{ uuid: 'u1', title: 'Camp', note: 'Bring boots', url: 'https://f.test/x?a=1,2;b=3', start_at: Date.UTC(2026, 9, 10, 18), end_at: Date.UTC(2026, 9, 10, 20), label_id: 4 }], { 4: 'Events' });
  assert.match(out, /URL:https:\/\/f\.test\/x\?a=1,2;b=3/);
  const [e] = parseCalendar(out, { now: NOW, days: 60, tz: 'Europe/London' });
  assert.equal(e.description, 'Bring boots');
  assert.equal(e.url, 'https://f.test/x?a=1,2;b=3');
  assert.deepEqual(e.categories, ['Events']);
});

test('the display event carries a short description and the QR link', () => {
  const [e] = parseCalendar(ics(vevent('1', 'Camp', '10', 'URL:https://f.test/x\r\nDESCRIPTION:Uniform: Blues\\nBring boots and a torch\\nhttps://f.test/x\r\n')), { now: NOW, days: 60, tz: 'Europe/London' });
  const shaped = shapeCalendarEvent(e, 'Europe/London');
  assert.equal(shaped.url, 'https://f.test/x');
  assert.equal(shaped.description, 'Bring boots and a torch');
  assert.equal(shortDescription('x'.repeat(300)).length, 140);
});

function serviceFor(settings, feeds) {
  const store = { load: () => ({ calendarTimezone: 'Europe/London', calendarDays: 60, ...settings }) };
  const fetchImpl = async url => {
    const body = feeds[url];
    if (body == null) throw new TypeError('fetch failed');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
  return createCalendarService({ store, fetchImpl, now: () => NOW });
}

test('several accounts are merged, duplicates shown once, and one broken account does not hide the rest', async () => {
  const feeds = {
    'https://g.test/g.ics': ics(vevent('a', 'Parade Night', '10'), vevent('b', 'Camp', '20')),
    'https://o.test/o.ics': ics(vevent('c', 'parade night', '10', 'URL:https://o.test/form\r\nDESCRIPTION:From Outlook\r\n'), vevent('d', 'Drill Comp', '15'))
  };
  const svc = serviceFor({ calendarAccounts: [
    { id: 'g', type: 'google', name: 'Google', enabled: true, url: 'https://g.test/g.ics' },
    { id: 'o', type: 'outlook', name: 'Outlook', enabled: true, url: 'https://o.test/o.ics' },
    { id: 'x', type: 'google', name: 'Broken', enabled: true, url: 'https://broken.test/x.ics' },
    { id: 'off', type: 'google', name: 'Off', enabled: false, url: 'https://g.test/g.ics' }
  ] }, feeds);
  const cal = await svc.get();
  assert.equal(cal.configured, true);
  assert.equal(cal.ok, true);
  assert.deepEqual(cal.events.map(e => e.title.toLowerCase()), ['parade night', 'drill comp', 'camp']);
  const parade = cal.events[0];
  assert.equal(parade.url, 'https://o.test/form'); // the copy with a link fills the gap
  assert.equal(parade.description, 'From Outlook');
  assert.equal(cal.accounts.length, 3);
  assert.match(cal.error, /Broken: /);
  assert.equal(cal.source, 'multi');
});

test('TimeTree accounts share one tag filter: an account with no ticked tag is skipped once any tag is ticked', async () => {
  const calls = [];
  const original = timetree.exportIcs;
  timetree.exportIcs = async opts => {
    calls.push(opts.email);
    return { ics: ics(vevent(opts.email, 'From ' + opts.email, '10')) };
  };
  try {
    const tt = (id, labelIds) => ({ id, type: 'timetree', name: id, enabled: true, email: id + '@x.test', password: 'pw', calendarId: '1', labelIds, uniformLabelIds: [], labels: [] });
    const svc = serviceFor({ calendarAccounts: [tt('a', [5]), tt('b', [])] }, {});
    const cal = await svc.get();
    assert.deepEqual(calls, ['a@x.test']);
    assert.deepEqual(cal.events.map(e => e.title), ['From a@x.test']);

    calls.length = 0;
    const all = await serviceFor({ calendarAccounts: [tt('a', []), tt('b', [])] }, {}).get();
    assert.deepEqual(calls.sort(), ['a@x.test', 'b@x.test']);
    assert.equal(all.events.length, 2);
  } finally {
    timetree.exportIcs = original;
  }
});
