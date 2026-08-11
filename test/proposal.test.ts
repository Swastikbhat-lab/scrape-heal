import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProposal } from '../src/llm.js';

test('parseProposal: plain JSON', () => {
  const p = parseProposal('{"items":".item","fields":{"name":".title","price":".cost"}}');
  assert.deepEqual(p, { items: '.item', fields: { name: '.title', price: '.cost' } });
});

test('parseProposal: tolerates markdown code fences', () => {
  const p = parseProposal('```json\n{"items":".item","fields":{"name":".title"}}\n```');
  assert.deepEqual(p, { items: '.item', fields: { name: '.title' } });
});

test('parseProposal: drops empty field selectors, keeps the usable ones', () => {
  const p = parseProposal('{"items":".item","fields":{"name":"", "price":".cost"}}');
  assert.deepEqual(p, { items: '.item', fields: { price: '.cost' } });
});

test('parseProposal: missing items selector throws', () => {
  assert.throws(() => parseProposal('{"fields":{"name":".title"}}'), /items/);
});

test('parseProposal: missing fields throws', () => {
  assert.throws(() => parseProposal('{"items":".item"}'), /fields/);
});

test('parseProposal: no usable fields throws', () => {
  assert.throws(() => parseProposal('{"items":".item","fields":{}}'), /no usable field/);
});

test('parseProposal: non-JSON garbage throws', () => {
  assert.throws(() => parseProposal('sure, .item probably works'), /not JSON/);
});
