import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberLLM, parseProposal, type SiteLLMMemory } from '../src/llm.js';

const p = (items: string) => parseProposal(`{"items":"${items}","fields":{"name":".title"}}`);
const at = '2026-08-11T00:00:00.000Z';

test('rememberLLM: a success is recorded with its old signature', () => {
  const mem = rememberLLM(undefined, { at, oldSig: '{"items":".a"}', ok: true, proposal: p('.tile') });
  assert.equal(mem.successes.length, 1);
  assert.equal(mem.successes[0].old, '{"items":".a"}');
  assert.equal(mem.successes[0].proposal.items, '.tile');
  assert.deepEqual(mem.misses, []);
});

test('rememberLLM: successes are deduped by proposal and move to the front', () => {
  let mem = rememberLLM(undefined, { at, oldSig: 's', ok: true, proposal: p('.a') });
  mem = rememberLLM(mem, { at, oldSig: 's', ok: true, proposal: p('.b') });
  mem = rememberLLM(mem, { at, oldSig: 's', ok: true, proposal: p('.a') });
  assert.equal(mem.successes.length, 2);
  assert.equal(mem.successes[0].proposal.items, '.a'); // re-proven → newest first
});

test('rememberLLM: successes capped at 3', () => {
  let mem: SiteLLMMemory | undefined;
  for (let i = 0; i < 6; i++) {
    mem = rememberLLM(mem, { at, oldSig: 's', ok: true, proposal: p(`.c${i}`) });
  }
  assert.equal(mem!.successes.length, 3);
  assert.equal(mem!.successes[0].proposal.items, '.c5');
  assert.ok(!mem!.successes.some((s) => s.proposal.items === '.c0'));
});

test('rememberLLM: a failure becomes a miss with the failure reason', () => {
  const mem = rememberLLM(undefined, {
    at, oldSig: 's', ok: false, proposal: p('.nope'), failure: 'expected at least 4 item(s), got 0',
  });
  assert.deepEqual(mem.successes, []);
  assert.equal(mem.misses.length, 1);
  assert.ok(mem.misses[0].includes('.nope'));
  assert.ok(mem.misses[0].includes('expected at least 4'));
});

test('rememberLLM: misses are deduped and capped at 5', () => {
  let mem: SiteLLMMemory | undefined;
  for (let i = 0; i < 8; i++) {
    mem = rememberLLM(mem, { at, oldSig: 's', ok: false, proposal: p(`.bad${i}`), failure: `fail ${i}` });
  }
  assert.equal(mem!.misses.length, 5);
  assert.ok(mem!.misses[0].includes('.bad7'));
  assert.ok(!mem!.misses.some((m) => m.includes('.bad0')));

  const before = mem!.misses.length;
  mem = rememberLLM(mem, { at, oldSig: 's', ok: false, proposal: p('.bad7'), failure: 'fail 7' });
  assert.equal(mem!.misses.length, before); // identical miss deduped
});

test('rememberLLM: does not mutate the previous memory', () => {
  const prev = rememberLLM(undefined, { at, oldSig: 's', ok: true, proposal: p('.a') });
  const next = rememberLLM(prev, { at, oldSig: 's', ok: false, proposal: p('.x'), failure: 'nope' });
  assert.equal(prev.successes.length, 1);
  assert.equal(prev.misses.length, 0);
  assert.equal(next.successes.length, 1);
  assert.equal(next.misses.length, 1);
});
