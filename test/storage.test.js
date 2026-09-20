const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, isHttpUrl } = require('../storage');

const defaults = {
  squadronName: 'Default', location: { name: 'Town', lat: 1, lon: 2 },
  leaderboardCsvUrl: '', eventsSeeMoreUrl: 'https://example.com', errorReportUrl: '',
  autoShutdownMinutes: 165, instagramEmbedCode: '', weatherEmbedCode: '', newsEmbedCode: '',
  importantInfo: { enabled: false, title: 'T', message: '' },
  widgets: { leaderboard: true, news: true, events: true, instagram: true },
  customWidgets: [], layout: 'auto', events: []
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sqn-store-'));

test('isHttpUrl accepts only http(s)', () => {
  assert.ok(isHttpUrl('https://docs.google.com/x'));
  assert.ok(isHttpUrl('http://192.168.1.5/x'));
  assert.ok(!isHttpUrl('javascript:alert(1)'));
  assert.ok(!isHttpUrl('file:///etc/passwd'));
  assert.ok(!isHttpUrl('not a url'));
});

test('sanitize keeps good URLs, allows blanking, ignores bad ones', () => {
  const store = createStore({ dir: tmp(), defaults });
  let cur = store.load();
  cur = store.sanitize(cur, { leaderboardCsvUrl: ' https://example.com/sheet.csv ' });
  assert.equal(cur.leaderboardCsvUrl, 'https://example.com/sheet.csv');
  cur = store.sanitize(cur, { leaderboardCsvUrl: 'file:///etc/passwd', errorReportUrl: 'javascript:alert(1)' });
  assert.equal(cur.leaderboardCsvUrl, 'https://example.com/sheet.csv');
  assert.equal(cur.errorReportUrl, '');
  cur = store.sanitize(cur, { leaderboardCsvUrl: '' });
  assert.equal(cur.leaderboardCsvUrl, '');
});

test('sanitize ignores junk and bad numbers', () => {
  const store = createStore({ dir: tmp(), defaults });
  const cur = store.load();
  const out = store.sanitize(cur, { squadronName: '   ', autoShutdownMinutes: -5, location: { lat: 999 }, layout: 'weird', events: 'nope' });
  assert.equal(out.squadronName, 'Default');
  assert.equal(out.autoShutdownMinutes, 165);
  assert.equal(out.location.lat, 1);
  assert.equal(out.layout, 'auto');
  assert.deepEqual(out.events, []);
});

test('custom widgets: ids are made safe and unique, list capped at 20', () => {
  const store = createStore({ dir: tmp(), defaults });
  const many = Array.from({ length: 30 }, () => ({ id: 'dup', name: 'n', title: 't', embedCode: 'x' }));
  const out = store.sanitize(store.load(), { customWidgets: many });
  assert.equal(out.customWidgets.length, 20);
  assert.equal(new Set(out.customWidgets.map(w => w.id)).size, 20);
});

test('corrupt data.json is restored from the backup', () => {
  const dir = tmp();
  const store = createStore({ dir, defaults });
  store.save({ ...defaults, squadronName: 'Saved' });
  fs.writeFileSync(path.join(dir, 'data.json'), '{ half a fi');
  assert.equal(store.load().squadronName, 'Saved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).squadronName, 'Saved');
});

test('both files corrupt: falls back to built-in defaults', () => {
  const dir = tmp();
  const store = createStore({ dir, defaults });
  fs.writeFileSync(path.join(dir, 'data.json'), 'x');
  fs.writeFileSync(path.join(dir, 'data.backup.json'), 'y');
  assert.equal(store.load().squadronName, 'Default');
});

test('settings saved by an older version get new defaults filled in', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ squadronName: 'Old' }));
  const store = createStore({ dir, defaults });
  const d = store.load();
  assert.equal(d.squadronName, 'Old');
  assert.equal(d.widgets.news, true);
});
