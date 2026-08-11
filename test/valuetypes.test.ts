import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyValue, kindsCompatible, profileField, verifyValueTypes,
} from '../src/valuetypes.js';

test('classifyValue: prices', () => {
  for (const v of ['$24.99', '$899', 'USD 12.99', 'EUR 45', '12,99 €', '$-5.00']) {
    assert.equal(classifyValue(v), 'price', v);
  }
});

test('classifyValue: percentages', () => {
  for (const v of ['20%', '-5.00%', '0.5%']) {
    assert.equal(classifyValue(v), 'percent', v);
  }
});

test('classifyValue: dates', () => {
  for (const v of ['2026-01-05', '2026-01-05T10:30:00', 'Jan 5, 2026', 'January 5, 2026', '01/05/2026', '12/31/24']) {
    assert.equal(classifyValue(v), 'date', v);
  }
});

test('classifyValue: urls and images', () => {
  assert.equal(classifyValue('https://example.com/p'), 'url');
  assert.equal(classifyValue('https://cdn.example.com/img/photo.png'), 'image');
  assert.equal(classifyValue('data:image/png;base64,iVBORw0KGgo='), 'image');
});

test('classifyValue: numbers and slugs', () => {
  for (const v of ['12.99', '1,234', '-5', '1000']) {
    assert.equal(classifyValue(v), 'number', v);
  }
  for (const v of ['SKU-123', 'tsla', 'GTX-4090', 'abc_1', 'USD']) {
    assert.equal(classifyValue(v), 'slug', v);
  }
});

test('classifyValue: everything else is text', () => {
  for (const v of ['Free shipping', 'Price on request', 'On sale', 'in stock', 'Wireless Mouse', '']) {
    assert.equal(classifyValue(v), 'text', v);
  }
});

test('kindsCompatible: price↔number and text accepts slug, asymmetric on slug', () => {
  assert.equal(kindsCompatible('price', 'number'), true);
  assert.equal(kindsCompatible('number', 'price'), true);
  assert.equal(kindsCompatible('price', 'price'), true);
  assert.equal(kindsCompatible('price', 'text'), false);
  // A word-like (text) field may flip between "in stock" and "Available"…
  assert.equal(kindsCompatible('slug', 'text'), true);
  // …but a code (slug) field must not start yielding prose.
  assert.equal(kindsCompatible('text', 'slug'), false);
  assert.equal(kindsCompatible('date', 'number'), false);
});

test('profileField: dominant kind and consistency', () => {
  assert.deepEqual(profileField(['$1', '$2', '$3']), { kind: 'price', rate: 1 });
  const mixed = profileField(['$1', '$2', 'free']); // 2 of 3 prices
  assert.deepEqual(mixed, { kind: 'price', rate: 2 / 3 });
  assert.equal(profileField([]), undefined);
  assert.equal(profileField(['', '  ']), undefined);
});

test('verifyValueTypes: same kind passes, wrong binding is refused', () => {
  const fields = [{ name: 'price' }, { name: 'name' }];
  const baseline = [
    { name: 'Wireless Mouse', price: '$24.99' },
    { name: 'Keyboard', price: '$89.00' },
  ];
  // Correct repair: new prices, still prices.
  const good = verifyValueTypes(fields, [
    { name: 'Ergo Mouse Pro', price: '$34.99' },
    { name: 'TKL Keyboard', price: '$99.00' },
  ], baseline);
  assert.deepEqual(good, []);

  // Wrong binding: a price field now yields prose.
  const bad = verifyValueTypes(fields, [
    { name: 'Ergo Mouse Pro', price: 'Price on request' },
    { name: 'TKL Keyboard', price: 'Price on request' },
  ], baseline);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /price/);
  assert.match(bad[0], /no longer look like a price/);
});

test('verifyValueTypes: a dropped currency sign still passes (price → number)', () => {
  const baseline = [{ name: 'A', price: '$24.99' }];
  const issues = verifyValueTypes([{ name: 'price' }], [
    { name: 'A', price: '24.99' },
    { name: 'B', price: '19.99' },
  ], baseline);
  assert.deepEqual(issues, []);
});

test('verifyValueTypes: text fields stay text — no false refusal', () => {
  const baseline = [
    { name: 'Wireless Mouse', stock: 'in stock' },
    { name: 'Keyboard', stock: 'out of stock' },
  ];
  const issues = verifyValueTypes([{ name: 'stock' }], [
    { name: 'Mouse', stock: 'Available' },
    { name: 'Keyboard', stock: 'Sold out' },
  ], baseline);
  assert.deepEqual(issues, []);
});

test('verifyValueTypes: tolerant of a mixed baseline', () => {
  // Baseline is 2/3 prices ("free" is text); a repair that is 2/3 prices passes.
  const baseline = [
    { name: 'A', price: '$24.99' },
    { name: 'B', price: '$89.00' },
    { name: 'C', price: 'free' },
  ];
  const issues = verifyValueTypes([{ name: 'price' }], [
    { name: 'A', price: '$34.99' },
    { name: 'B', price: '$99.00' },
    { name: 'C', price: 'on request' },
  ], baseline);
  assert.deepEqual(issues, []);
});

test('verifyValueTypes: skips fields with no baseline to profile', () => {
  const issues = verifyValueTypes([{ name: 'note' }], [
    { name: 'A', note: 'anything at all' },
  ], [{ name: 'A', note: '' }]);
  assert.deepEqual(issues, []);
});

test('verifyValueTypes: a forced type override demands that kind', () => {
  const baseline = [{ name: 'A', price: '$24.99' }];
  const issues = verifyValueTypes([{ name: 'price', type: 'price' }], [
    { name: 'A', price: 'On sale' },
    { name: 'B', price: 'bestseller' },
  ], baseline);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /no longer look like a price/);
});
