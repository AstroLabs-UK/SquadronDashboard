// End-to-end: a real (local) calendar feed -> /api/events and /api/uniform, plus the remote
// control, config export/import and the private-link handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tz = require('../lib/tz');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-evapi-'));
process.env.DATA_DIR = dataDir;
process.env.AUTO_UPDATE = '0';
process.env.SENSITIVE_RATE_MAX = '1000';
process.env.DATA_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-evsnap-'));
delete process.env.EDIT_PIN;

const app = require('../server');
let server, base, feed, feedUrl, feedHits = 0, feedBody = '';

const pad = n => String(n).padStart(2, '0');
const stamp = ms => { const d = new Date(ms); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00Z'; };
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function loginCookie(pin) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (setCookie && setCookie.length) return setCookie.map(c => c.split(';')[0]).join('; ');
  const raw = r.headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(',').map(c => c.split(';')[0].trim()).join('; ');
}
const cookieHdr = c => (c ? { Cookie: c } : {});

function buildFeed() {
  const now = Date.now();
  const today = tz.dateKey(now, 'Europe/London');
  const nextMon = tz.addDaysKey(tz.mondayKey(today), 7);
  const nextThu = tz.addDaysKey(nextMon, 3);
  const at = (key, h) => tz.wallToInstant(tz.wallOfKey(key) + h * 3600000, 'Europe/London');
  const ev = (uid, s, e, summary, desc = '') => ['BEGIN:VEVENT', 'UID:' + uid, 'DTSTART:' + stamp(s), 'DTEND:' + stamp(e), 'SUMMARY:' + summary, desc ? 'DESCRIPTION:' + desc : '', 'END:VEVENT'].filter(Boolean).join('\r\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0',
    ev('a', now + 26 * 3600000, now + 28 * 3600000, 'Drill practice'),
    ev('b', at(nextThu, 19), at(nextThu, 21), 'Parade Night', 'Uniform: Working blues\\nBring a pen'),
    ev('c', now - 10 * 86400000, now - 10 * 86400000 + 3600000, 'Long gone'),
    'END:VCALENDAR'].join('\r\n');
}

test.before(async () => {
  feedBody = buildFeed();
  feed = http.createServer((req, res) => { feedHits++; res.setHeader('Content-Type', 'text/calendar'); res.end(feedBody); });
  await new Promise(r => feed.listen(0, '127.0.0.1', r));
  feedUrl = 'http://127.0.0.1:' + feed.address().port + '/basic.ics';
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); feed.close(); });

test('with no calendar link the typed events still work (and expired ones are hidden)', async () => {
  await post('/api/data', { events: [
    { title: 'Bake sale', date: 'Saturday', detail: 'Main hall' },
    { title: 'Old news', date: 'Last week', detail: '', hideAfter: '2020-01-01' },
    { title: 'Until far off', date: 'Soon', detail: '', hideAfter: '2099-01-01' }
  ] });
  const r = await (await fetch(base + '/api/events')).json();
  assert.deepEqual(r.events.map(e => e.title), ['Bake sale', 'Until far off']);
  assert.equal(r.calendar.configured, false);
});

test('a calendar link adds upcoming events, newest-first order, and drops old ones', async () => {
  const saved = await (await post('/api/data', { icsUrl: feedUrl })).json();
  assert.equal(saved.data.icsUrl, feedUrl);
  const r = await (await fetch(base + '/api/events')).json();
  assert.equal(r.calendar.configured, true);
  assert.equal(r.calendar.ok, true, JSON.stringify(r.calendar));
  const titles = r.events.map(e => e.title);
  assert.deepEqual(titles, ['Bake sale', 'Until far off', 'Drill practice', 'Parade Night']);
  const parade = r.events.find(e => e.title === 'Parade Night');
  assert.match(parade.date, /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  assert.match(parade.detail, /^\d\d:\d\d–\d\d:\d\d$/);
  assert.equal(parade.source, 'calendar');
});

test('the calendar is cached: repeated requests do not hit the feed again', async () => {
  const before = feedHits;
  await fetch(base + '/api/events'); await fetch(base + '/api/uniform'); await fetch(base + '/api/events');
  assert.equal(feedHits, before);
});

test('/api/uniform finds "Uniform:" in a calendar event for next week', async () => {
  await post('/api/data', { uniform: { items: [{ date: tz.addDaysKey(tz.mondayKey(tz.dateKey(Date.now(), 'Europe/London')), 8), title: 'Cadet Sunday', uniform: 'PT kit' }] } });
  const u = await (await fetch(base + '/api/uniform')).json();
  assert.equal(u.nextWeek.length, 2);
  assert.deepEqual(u.nextWeek.map(x => x.uniform).sort(), ['PT kit', 'Working blues']);
  assert.equal(u.nextWeek.find(x => x.uniform === 'Working blues').title, 'Parade Night');
  assert.ok(Array.isArray(u.thisWeek));
});

test('a broken calendar link does not break the display: typed events remain and the error is reported', async () => {
  await post('/api/data', { icsUrl: 'http://127.0.0.1:1/nothing.ics' });
  const r = await (await fetch(base + '/api/events')).json();
  assert.equal(r.calendar.ok, false);
  assert.ok(r.calendar.error);
  assert.deepEqual(r.events.map(e => e.title), ['Bake sale', 'Until far off']);
});

test('the calendar link is private: hidden from the public page when a PIN is set', async () => {
  await post('/api/data', { icsUrl: feedUrl });
  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '2468\n');
  const anon = await (await fetch(base + '/api/data')).json();
  assert.equal(anon.icsUrl, '');
  assert.equal(anon.icsUrlSet, true);
  const editor = await (await fetch(base + '/api/data', { headers: cookieHdr(await loginCookie('2468')) })).json();
  assert.equal(editor.icsUrl, feedUrl);
  // and the private link is never in the public events/uniform replies
  const pub = JSON.stringify(await (await fetch(base + '/api/events')).json());
  assert.ok(!pub.includes(feedUrl));
  fs.rmSync(path.join(dataDir, 'edit-pin'));
});

test('remote control: reload and notice reach the display through /api/boot, and need the PIN', async () => {
  const b0 = await (await fetch(base + '/api/boot')).json();
  assert.equal(b0.notice, null);
  await post('/api/control', { action: 'reload' });
  const b1 = await (await fetch(base + '/api/boot')).json();
  assert.equal(b1.reload, b0.reload + 1);

  assert.equal((await post('/api/control', { action: 'notice', text: '   ' })).status, 400);
  assert.equal((await post('/api/control', { action: 'nope' })).status, 400);
  await post('/api/control', { action: 'notice', text: 'Parade moved to the hall', minutes: 5 });
  const b2 = await (await fetch(base + '/api/boot')).json();
  assert.equal(b2.notice.text, 'Parade moved to the hall');
  assert.ok(b2.notice.secondsLeft > 250 && b2.notice.secondsLeft <= 300);
  await post('/api/control', { action: 'clear-notice' });
  assert.equal((await (await fetch(base + '/api/boot')).json()).notice, null);

  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '2468\n');
  assert.equal((await post('/api/control', { action: 'reload' })).status, 401);
  const ctlCookie = await loginCookie('2468');
  assert.equal((await post('/api/control', { action: 'reload' }, cookieHdr(ctlCookie))).status, 200);
  fs.rmSync(path.join(dataDir, 'edit-pin'));
});

test('config export then import restores everything (and the export needs the PIN)', async () => {
  await post('/api/data', { squadronName: 'Export Squadron', icsUrl: feedUrl });
  const res = await fetch(base + '/api/config/export');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="squadron-dashboard-config-\d{4}-\d\d-\d\d\.json"/);
  const file = await res.json();
  assert.equal(file.format, 'squadron-dashboard-config');
  assert.equal(file.settings.squadronName, 'Export Squadron');
  assert.equal(file.settings.icsUrl, feedUrl);

  await post('/api/data', { squadronName: 'Something else' });
  const imp = await post('/api/config/import', file);
  assert.equal(imp.status, 200);
  assert.equal((await (await fetch(base + '/api/data')).json()).squadronName, 'Export Squadron');
  assert.ok(fs.existsSync(path.join(dataDir, 'data.before-import.json')), 'a safety copy is kept');

  assert.equal((await post('/api/config/import', { format: 'other', settings: {} })).status, 400);
  assert.equal((await post('/api/config/import', { hello: 1 })).status, 400);

  fs.writeFileSync(path.join(dataDir, 'edit-pin'), '2468\n');
  assert.equal((await fetch(base + '/api/config/export')).status, 401);
  assert.equal((await post('/api/config/import', file)).status, 401);
  fs.rmSync(path.join(dataDir, 'edit-pin'));
});

test('an import is validated like typed input: bad values are ignored, missing ones reset to defaults', async () => {
  await post('/api/data', { squadronName: 'Before', eventsSeeMoreUrl: 'https://example.com/x' });
  const imp = await post('/api/config/import', { format: 'squadron-dashboard-config', settings: { squadronName: 'Imported', icsUrl: 'javascript:alert(1)', calendarDays: 99999 } });
  const d = (await imp.json()).data;
  assert.equal(d.squadronName, 'Imported');
  assert.equal(d.icsUrl, '');
  assert.equal(d.calendarDays, 60);
  assert.equal(d.eventsSeeMoreUrl, 'https://cadets.bader.mod.uk/events');
});

test('webcal:// links are accepted and stored as https://', async () => {
  const r = await (await post('/api/data', { icsUrl: 'webcal://calendar.google.com/calendar/ical/x/private-y/basic.ics' })).json();
  assert.equal(r.data.icsUrl, 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics');
});

test('/api/status includes calendar and system health', async () => {
  await post('/api/data', { icsUrl: feedUrl });
  const s = await (await fetch(base + '/api/status')).json();
  assert.equal(s.calendar, 'ONLINE');
  assert.ok(s.calendarInfo.events >= 2);
  assert.ok(s.system.memory.totalMB > 0);
  assert.ok('cpuTempC' in s.system);
});
