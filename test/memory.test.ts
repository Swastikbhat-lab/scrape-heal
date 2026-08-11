import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMemory } from '../src/memory.js';
import { parseProposal, type SiteLLMMemory } from '../src/llm.js';

const mem: Record<string, SiteLLMMemory> = {
  'https://shop.example.com': {
    site: 'https://shop.example.com',
    successes: [
      {
        at: '2026-08-11T00:00:00.000Z',
        old: '{"items":".product-card"}',
        proposal: parseProposal('{"items":".tile","fields":{"name":".title"}}'),
      },
    ],
    misses: ['{"items":".nope"} — expected at least 4 item(s), got 0'],
  },
};

test('formatMemory: shows the verified repair and the miss for a site', () => {
  const out = formatMemory(mem, 'https://shop.example.com');
  assert.ok(out.includes('site: https://shop.example.com'));
  assert.ok(out.includes('verified repairs (newest first)'));
  assert.ok(out.includes('old {"items":".product-card"} → new'));
  assert.ok(out.includes('failed proposals (newest first)'));
  assert.ok(out.includes('.nope'));
});

test('formatMemory: site match tolerates a trailing-slash URL', () => {
  const out = formatMemory(mem, 'https://shop.example.com/');
  assert.ok(out.includes('site: https://shop.example.com'));
});

test('formatMemory: with no site, every remembered site is shown', () => {
  const out = formatMemory(mem);
  assert.ok(out.includes('site: https://shop.example.com'));
});

test('formatMemory: unknown site reports nothing and hints at remembered ones', () => {
  const out = formatMemory(mem, 'https://other.example.com');
  assert.ok(out.includes('no per-site LLM memory found for "https://other.example.com"'));
  assert.ok(out.includes('shop.example.com'));
});

test('formatMemory: empty memory says so', () => {
  const out = formatMemory({});
  assert.ok(out.includes('no per-site LLM memory found'));
});
