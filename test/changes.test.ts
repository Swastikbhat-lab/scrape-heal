import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffChanges, formatChanges, matchesThresholds, parseNumber, reportHasChanges,
  type ChangeReport,
} from '../src/changes.js';

test('parseNumber: strips currency, grouping, and percent noise', () => {
  assert.equal(parseNumber('$24.99'), 24.99);
  assert.equal(parseNumber('1,299'), 1299);
  assert.equal(parseNumber('5%'), 5);
  assert.equal(parseNumber(' € 1 200 '), 1200);
  assert.equal(parseNumber('n/a'), null);
  assert.equal(parseNumber('out of stock'), null);
  assert.equal(parseNumber(''), null);
});

const prev = [
  { name: 'Mouse', price: '$24.99', stock: 'in stock' },
  { name: 'Keyboard', price: '$89.00', stock: 'in stock' },
];
const curr = [
  { name: 'Mouse', price: '$19.99', stock: 'in stock' },   // price dropped
  { name: 'Keyboard', price: '$89.00', stock: 'out of stock' }, // stock flipped
  { name: 'Monitor', price: '$199.00', stock: 'in stock' }, // new item
];

test('diffChanges: added, removed, and per-field changes', () => {
  const r = diffChanges(prev, curr, 'name');
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].name, 'Monitor');
  assert.equal(r.removed.length, 0);
  assert.equal(r.changed.length, 2);
  assert.deepEqual(r.count, { from: 2, to: 3 });

  const price = r.changed.find((c) => c.field === 'price');
  assert.ok(price);
  assert.equal(price.id, 'Mouse');
  assert.equal(price.from, '$24.99');
  assert.equal(price.to, '$19.99');
  assert.ok(price.numeric);
  assert.equal(price.numeric.from, 24.99);
  assert.equal(price.numeric.to, 19.99);
  assert.ok(Math.abs(price.numeric.pct + 20) < 0.01, 'a $24.99 → $19.99 drop is ≈ -20%');

  const stock = r.changed.find((c) => c.field === 'stock');
  assert.ok(stock);
  assert.equal(stock.to, 'out of stock');
  assert.equal(stock.numeric, undefined, 'non-numeric values carry no numeric diff');
});

test('diffChanges: identity field is never reported as a change', () => {
  const r = diffChanges(prev, curr, 'name');
  assert.ok(!r.changed.some((c) => c.field === 'name'));
});

test('diffChanges: removals surface when identities disappear', () => {
  const r = diffChanges(prev, [prev[0]], 'name');
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].name, 'Keyboard');
  assert.equal(r.added.length, 0);
  assert.equal(r.changed.length, 0);
});

test('diffChanges: deterministic order (sorted by id, then field)', () => {
  const a = [
    { name: 'Zebra', v: '1' },
    { name: 'Alpha', v: '1' },
  ];
  const b = [
    { name: 'Alpha', v: '2' },
    { name: 'Zebra', v: '2' },
  ];
  const r = diffChanges(a, b, 'name');
  assert.deepEqual(r.changed.map((c) => c.id), ['Alpha', 'Zebra']);
});

test('reportHasChanges: true only when something actually changed', () => {
  const same = diffChanges(prev, [...prev], 'name');
  assert.equal(reportHasChanges(same), false);
  const diff = diffChanges(prev, curr, 'name');
  assert.equal(reportHasChanges(diff), true);
});

test('formatChanges: one line per change, with numeric delta', () => {
  const r = diffChanges(prev, curr, 'name');
  const lines = formatChanges(r, 'name');
  assert.ok(lines.some((l) => l.includes('+ 1 new')));
  assert.ok(lines.some((l) => l.includes('Mouse')));
  assert.ok(lines.some((l) => l.includes('-20')));
});

test('matchesThresholds: dropPercent trips on numeric drops', () => {
  const r = diffChanges(prev, curr, 'name');
  const hits = matchesThresholds(r, [{ field: 'price', dropPercent: 5 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'price dropped ≥ 5%');
  assert.ok(hits[0].detail.some((d) => d.includes('Mouse')));
});

test('matchesThresholds: a drop below the threshold does not trip', () => {
  const r = diffChanges(prev, curr, 'name');
  assert.deepEqual(matchesThresholds(r, [{ field: 'price', dropPercent: 50 }]), []);
  assert.deepEqual(matchesThresholds(r, [{ field: 'stock', dropPercent: 5 }]), []);
});

test('matchesThresholds: risePercent trips on rises', () => {
  const up = diffChanges(
    prev,
    [{ name: 'Mouse', price: '$29.99', stock: 'in stock' }, prev[1]],
    'name',
  );
  const hits = matchesThresholds(up, [{ field: 'price', risePercent: 10 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'price rose ≥ 10%');
});

test('matchesThresholds: changedTo detects a restock', () => {
  const r = diffChanges(prev, curr, 'name');
  const hits = matchesThresholds(r, [{ field: 'stock', changedTo: 'out of stock' }]);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].detail[0].includes('Keyboard'));
  // the opposite direction trips nothing
  assert.deepEqual(matchesThresholds(r, [{ field: 'stock', changedTo: 'in stock' }]), []);
});

test('matchesThresholds: changedFrom detects an item leaving a state', () => {
  const r = diffChanges(prev, curr, 'name');
  const hits = matchesThresholds(r, [{ field: 'stock', changedFrom: 'in stock' }]);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].detail[0].includes('out of stock'));
});

test('matchesThresholds: anyChange and added', () => {
  const r = diffChanges(prev, curr, 'name');
  assert.equal(matchesThresholds(r, [{ anyChange: true }]).length, 1);
  assert.equal(matchesThresholds(r, [{ added: true }]).length, 1);
  assert.equal(matchesThresholds(r, [{ removed: true }]).length, 0);
  const gone = diffChanges(prev, [prev[0]], 'name');
  assert.equal(matchesThresholds(gone, [{ removed: true }]).length, 1);
});

test('matchesThresholds: conditions within one threshold are OR-ed', () => {
  const r = diffChanges(prev, curr, 'name');
  const hits = matchesThresholds(r, [{ field: 'price', dropPercent: 50, risePercent: 5 }]);
  assert.equal(hits.length, 0, 'neither condition matches — no hit');
  const hits2 = matchesThresholds(r, [{ field: 'price', dropPercent: 5, risePercent: 5 }]);
  assert.equal(hits2.length, 1, 'the drop condition matches — one hit');
});

test('matchesThresholds: a report with no changes trips nothing', () => {
  const same: ChangeReport = { added: [], removed: [], changed: [], count: { from: 2, to: 2 } };
  assert.deepEqual(matchesThresholds(same, [{ added: true }, { field: 'price', anyChange: true }]), []);
});
