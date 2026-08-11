import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScraperConfig } from '../src/scraper.js';
import type { WatchState } from '../src/watchdog.js';
import { rememberLedger, configSignature } from '../src/watchdog.js';

const cfg = (items: string, nameSel: string): ScraperConfig => ({
  url: 'https://example.com',
  items,
  fields: [
    { name: 'name', selector: nameSel },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
});

const freshState = (): WatchState => ({
  config: cfg('.product-card', '.name'),
  baseline: [],
  ledger: [],
  lastStatus: 'healthy',
  lastCheckedAt: new Date().toISOString(),
  alertCount: 0,
});

test('configSignature: field order does not matter', () => {
  const a = cfg('.item', '.title');
  const b: ScraperConfig = {
    ...a,
    fields: [
      { name: 'price', selector: '.price' },
      { name: 'name', selector: '.title' },
    ],
  };
  assert.equal(configSignature(a), configSignature(b));
});

test('configSignature: different selectors are different', () => {
  assert.notEqual(configSignature(cfg('.item', '.title')), configSignature(cfg('.tile', '.title')));
});

test('rememberLedger: newest first, deduped by selector signature', () => {
  const state = freshState();
  rememberLedger(state, cfg('.a', '.x'), 't1');
  rememberLedger(state, cfg('.b', '.y'), 't2');
  rememberLedger(state, cfg('.a', '.x'), 't3'); // re-proven — should move to front, not duplicate
  assert.equal(state.ledger.length, 2);
  assert.equal(state.ledger[0].config.items, '.a');
  assert.equal(state.ledger[1].config.items, '.b');
  assert.equal(state.ledger[0].verifiedAt, 't3');
});

test('rememberLedger: capped at 8 entries', () => {
  const state = freshState();
  for (let i = 0; i < 12; i++) {
    rememberLedger(state, cfg(`.c${i}`, `.s${i}`), `t${i}`);
  }
  assert.equal(state.ledger.length, 8);
  // Newest survives, oldest dropped
  assert.equal(state.ledger[0].config.items, '.c11');
  assert.ok(!state.ledger.some((e) => e.config.items === '.c0'));
});

test('rememberLedger: hits start at zero for a re-proven config', () => {
  const state = freshState();
  state.ledger = [{ config: cfg('.a', '.x'), verifiedAt: 'old', hits: 5 }];
  rememberLedger(state, cfg('.a', '.x'), 'now');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].hits, 0);
});
