const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLeaderboard } = require('../lib/leaderboard');
const { parseCsv } = require('../lib/csv');

const sheet = [
  'SQUADRON POINTS,,,',
  ',,,',
  'LEADERBOARD - RANKED,,,',
  'Rank,Name,Flight,Points',
  '1,Alice,Red,50',
  '2,"Bob, Jr",Blue,40',
  '3,Cara,Red,30',
  '4,Dan,N/A,20',
  '5,Eve,Blue,10',
  '6,Fay,Green,5',
  ',,,',
  'Something else,,,'
].join('\n');

test('reads under the header, stops at the first blank name, top 5 only', () => {
  const r = buildLeaderboard(parseCsv(sheet));
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows.map(x => x.name), ['Alice', 'Bob, Jr', 'Cara', 'Dan', 'Eve']);
});

test('flights are summed, blank/N/A ignored, top 3', () => {
  const r = buildLeaderboard(parseCsv(sheet));
  assert.deepEqual(r.flightRows, [
    { flight: 'Red', points: 80 },
    { flight: 'Blue', points: 50 },
    { flight: 'Green', points: 5 }
  ]);
});

test('no rank column: sorted by points', () => {
  const r = buildLeaderboard(parseCsv('Name,Points\nA,1\nB,9\nC,5'));
  assert.deepEqual(r.rows.map(x => x.name), ['B', 'C', 'A']);
  assert.equal(r.flightRows, null);
});

test('no header row / no points column give a helpful note', () => {
  assert.match(buildLeaderboard(parseCsv('foo,bar\n1,2')).note, /header/i);
  assert.match(buildLeaderboard(parseCsv('Rank,Name\n1,A')).note, /Points/);
});
