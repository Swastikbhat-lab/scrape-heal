import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTargetConfigs, fieldsFrom } from '../src/config.js';

const globalCfg = {
  url: 'https://default.example.com',
  items: '.product-card',
  fields: { name: '.name', price: '.price' },
  identityField: 'name',
  minItems: 4,
  intervalSeconds: 300,
  llm: { apiKey: 'sk-global', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  validator: 'schema.js',
};

test('mergeTargetConfigs: target values win over global defaults', () => {
  const merged = mergeTargetConfigs(globalCfg, {
    url: 'https://shop-a.example.com',
    items: '.tile',
    intervalSeconds: 600,
  });
  assert.equal(merged.url, 'https://shop-a.example.com');
  assert.equal(merged.items, '.tile');
  assert.equal(merged.intervalSeconds, 600);
  // inherited from global
  assert.deepEqual(merged.fields, { name: '.name', price: '.price' });
  assert.equal(merged.identityField, 'name');
  assert.equal(merged.minItems, 4);
});

test('mergeTargetConfigs: llm is deep-merged (target overrides just maxAttempts)', () => {
  const merged = mergeTargetConfigs(globalCfg, { llm: { maxAttempts: 5 } });
  assert.equal(merged.llm?.apiKey, 'sk-global'); // inherited
  assert.equal(merged.llm?.model, 'gpt-4o-mini'); // inherited
  assert.equal(merged.llm?.maxAttempts, 5); // target wins
});

test('mergeTargetConfigs: targets never inherit from other targets', () => {
  const merged = mergeTargetConfigs(
    { ...globalCfg, targets: [{ url: 'https://x.example.com' }] },
    { url: 'https://y.example.com' },
  );
  assert.equal(merged.targets, undefined);
});

test('mergeTargetConfigs: per-target validator and url are independent', () => {
  const a = mergeTargetConfigs(globalCfg, { validator: 'validator-a.js' });
  const b = mergeTargetConfigs(globalCfg, { validator: 'validator-b.js' });
  assert.equal(a.validator, 'validator-a.js');
  assert.equal(b.validator, 'validator-b.js');
});

test('fieldsFrom: object form maps to field list', () => {
  const fields = fieldsFrom({ name: '.n', price: '.p' }, undefined);
  assert.deepEqual(fields, [
    { name: 'name', selector: '.n' },
    { name: 'price', selector: '.p' },
  ]);
});
