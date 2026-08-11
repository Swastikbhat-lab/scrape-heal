import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScraperConfig, ExtractedItem } from '../src/scraper.js';
import { validate, validateShape } from '../src/scraper.js';

const config: ScraperConfig = {
  url: 'https://example.com/products',
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
};

const goodItems: ExtractedItem[] = [
  { name: 'Wireless Mouse', price: '$24.99' },
  { name: 'Mechanical Keyboard', price: '$89.00' },
  { name: 'USB-C Hub', price: '$39.50' },
  { name: '4K Monitor', price: '$299.00' },
];

test('validateShape: ok on enough items with no empty fields', () => {
  const v = validateShape(config, goodItems);
  assert.equal(v.ok, true);
  assert.equal(v.itemCount, 4);
  assert.deepEqual(v.issues, []);
});

test('validateShape: too few items is broken', () => {
  const v = validateShape(config, goodItems.slice(0, 2));
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.includes('expected at least 4')));
});

test('validateShape: empty required field is broken', () => {
  const items = [...goodItems];
  items[1] = { name: 'Mechanical Keyboard', price: '' };
  const v = validateShape(config, items);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.includes('"price" is empty in 1 of 4')));
});

test('validate: baseline identity values all present → ok', () => {
  const v = validate(config, goodItems, goodItems);
  assert.equal(v.ok, true);
});

test('validate: missing a known identity value → broken', () => {
  // Same count (shape passes) but "Wireless Mouse" was replaced by a new value.
  const items = goodItems.map((it) =>
    it.name === 'Wireless Mouse' ? { ...it, name: 'Ergo Mouse Pro' } : it,
  );
  const v = validate(config, items, goodItems);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.includes('missing known value(s): Wireless Mouse')));
});

test('validate: wrong-but-shaped data is broken (the silent failure case)', () => {
  // Same count, same fields, but a known identity is gone — the case a naive
  // shape check would wave through.
  const wrong: ExtractedItem[] = [
    { name: 'Fake Product A', price: '$1.00' },
    { name: 'Mechanical Keyboard', price: '$89.00' },
    { name: 'USB-C Hub', price: '$39.50' },
    { name: '4K Monitor', price: '$299.00' },
  ];
  const v = validate(config, wrong, goodItems);
  assert.equal(v.ok, false);
});

test('validate: a pluggable validator replaces the built-in checks entirely', () => {
  // This validator always passes, even with 0 items and a missing identity —
  // proving the built-in checks no longer run.
  const always = () => ({ ok: true, itemCount: 0, issues: [] });
  const v = validate(config, [], goodItems, always);
  assert.equal(v.ok, true);

  const strict = (items: ExtractedItem[]) => ({
    ok: items.every((it) => /^\$\d/.test(it.price)),
    itemCount: items.length,
    issues: items.filter((it) => !/^\$\d/.test(it.price)).map((it) => `bad price ${it.price}`),
  });
  const bad = validate(config, [{ name: 'a', price: '9.99' }], [], strict);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.issues, ['bad price 9.99']);
});
