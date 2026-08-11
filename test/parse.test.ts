import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../src/source.js';

test('parseRows: JSON array', () => {
  const rows = parseRows('[{"name":"a","price":"$1"},{"name":"b","price":"$2"}]');
  assert.deepEqual(rows, [
    { name: 'a', price: '$1' },
    { name: 'b', price: '$2' },
  ]);
});

test('parseRows: JSON lines (one object per line — Scrapy stdout default)', () => {
  const rows = parseRows('{"name":"a","price":"$1"}\n{"name":"b","price":"$2"}\n');
  assert.deepEqual(rows, [
    { name: 'a', price: '$1' },
    { name: 'b', price: '$2' },
  ]);
});

test('parseRows: CSV with header row', () => {
  const rows = parseRows('name,price\nWireless Mouse,$24.99\n4K Monitor,$299.00');
  assert.deepEqual(rows, [
    { name: 'Wireless Mouse', price: '$24.99' },
    { name: '4K Monitor', price: '$299.00' },
  ]);
});

test('parseRows: CSV with quoted fields (embedded commas and doubled quotes)', () => {
  const rows = parseRows('name,note\n"Mouse, wireless","says ""hi"""');
  assert.deepEqual(rows, [{ name: 'Mouse, wireless', note: 'says "hi"' }]);
});

test('parseRows: empty input → empty list (a crash, not a site change)', () => {
  assert.deepEqual(parseRows('   \n  '), []);
});

test('parseRows: a lone JSON object is one JSONL row', () => {
  assert.deepEqual(parseRows('{"name":"a"}'), [{ name: 'a' }]);
});

test('parseRows: malformed JSON throws (the caller reports a source failure)', () => {
  assert.throws(() => parseRows('[{broken'));
});

test('parseRows: CSV with only a header → empty list', () => {
  assert.deepEqual(parseRows('name,price\n'), []);
});
