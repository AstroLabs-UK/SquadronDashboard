const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../lib/csv');

test('plain rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('quoted cell containing a comma', () => {
  assert.deepEqual(parseCsv('name,points\n"O\'Brien, J",12'), [['name', 'points'], ["O'Brien, J", '12']]);
});

test('escaped quotes inside a quoted cell', () => {
  assert.deepEqual(parseCsv('a\n"He said ""hi"""'), [['a'], ['He said "hi"']]);
});

test('line break inside a quoted cell stays in one cell', () => {
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",x'), [['a', 'b'], ['line1\nline2', 'x']]);
});

test('CRLF, lone CR and a BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n1,2\r3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('blank row in the middle is kept, trailing blank rows are dropped', () => {
  assert.deepEqual(parseCsv('a\n\nb\n\n\n'), [['a'], [''], ['b']]);
});

test('empty cells and trimming', () => {
  assert.deepEqual(parseCsv(' a , ,c '), [['a', '', 'c']]);
});

test('a quote in the middle of an unquoted cell is literal', () => {
  assert.deepEqual(parseCsv('5" pipe,x'), [['5" pipe', 'x']]);
});

test('empty input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
});
