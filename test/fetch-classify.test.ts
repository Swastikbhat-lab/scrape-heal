import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse } from '../src/scraper.js';

test('classifyResponse: 5xx is transient — retry, never heal', () => {
  assert.equal(classifyResponse(500), 'transient');
  assert.equal(classifyResponse(502), 'transient');
  assert.equal(classifyResponse(503), 'transient');
  assert.equal(classifyResponse(504), 'transient');
});

test('classifyResponse: 403/429 are blocks — rotate proxies, never heal', () => {
  assert.equal(classifyResponse(403), 'block');
  assert.equal(classifyResponse(429), 'block');
});

test('classifyResponse: a block-page signature on a 200 is still a block', () => {
  assert.equal(classifyResponse(200, 'Just a moment...'), 'block');
  assert.equal(classifyResponse(200, 'cf-browser-verification'), 'block');
  assert.equal(classifyResponse(200, 'Access Denied'), 'block');
  assert.equal(classifyResponse(200, 'Checking your browser before accessing'), 'block');
  assert.equal(classifyResponse(200, 'captcha'), 'block');
});

test('classifyResponse: a normal 200 is fine — breakage is decided by shape', () => {
  assert.equal(classifyResponse(200, '<html><body><div class="product-card">…</div></body></html>'), undefined);
  assert.equal(classifyResponse(404, 'Not Found'), undefined, 'a 404 page that loads is breakage, not a block');
  assert.equal(classifyResponse(undefined), undefined, 'no status (same-document nav) is fine');
});
