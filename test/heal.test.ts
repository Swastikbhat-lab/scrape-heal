import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { extract, validate } from '../src/scraper.js';
import { heal } from '../src/heal.js';

const fixture = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', name);

/** One local server whose served file can be swapped between tests. */
function startSite() {
  const current = { file: fixture('site-v1.html') };
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current.file));
  });
  return new Promise<{ url: string; serve: (name: string) => void; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({
        url: `http://127.0.0.1:${port}/`,
        serve: (name) => {
          current.file = fixture(name);
        },
        close: () => server.close(),
      });
    });
  });
}

/** A stub OpenAI-compatible /v1/chat/completions endpoint returning canned content. */
function startMockLLM(content: string) {
  const server = createServer((req, res) => {
    req.on('data', () => {}); // drain — the reply is canned
    req.on('end', () => {});
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return new Promise<{ baseUrl: string; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

const config: ScraperConfig = {
  url: '', // set per test
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
};

let browser: Browser;
let site: { url: string; serve: (name: string) => void; close: () => void };

before(async () => {
  browser = await chromium.launch();
  site = await startSite();
});

after(async () => {
  await browser.close();
  site.close();
});

test('heal: repairs a redesign by text and only ships a verified config', async () => {
  site.serve('site-v1.html');
  const baseline = await extract({ ...config, url: site.url }, await browser.newPage());

  // The site redeploys with renamed classes but the same data.
  site.serve('site-v2.html');
  const broken = await extract({ ...config, url: site.url }, await browser.newPage());
  assert.equal(broken.length, 0); // .product-card no longer exists

  const result = await heal(browser, { ...config, url: site.url }, baseline);
  assert.equal(result.repaired, true);
  assert.equal(result.config.items, '.item');
  assert.ok(result.verified && result.verified.length === 4);

  // The shipped config re-extracts the page AND passes the full gate,
  // including the baseline identity check.
  const check = await extract(result.config, await browser.newPage());
  const v = validate(result.config, check, baseline);
  assert.equal(v.ok, true);
});

test('heal: LLM path repairs when the data itself changed (no text anchor)', async () => {
  site.serve('site-v1.html');
  const baseline = await extract({ ...config, url: site.url }, await browser.newPage());

  // v3 renames the classes AND changes every value — nothing to match by text.
  site.serve('site-v3.html');
  const mock = await startMockLLM('{"items":".tile","fields":{"name":".title","price":".cost"}}');
  try {
    const result = await heal(
      browser,
      { ...config, url: site.url },
      baseline,
      { llm: { baseUrl: mock.baseUrl } }, // keyless — works with local endpoints
    );
    assert.equal(result.repaired, true);
    assert.equal(result.config.items, '.tile');
    assert.ok(result.verified && result.verified.length === 4);
    assert.ok(
      result.attempts.some((a) => a.includes('heal-llm: PASS')),
      'expected the LLM pass to be logged',
    );
  } finally {
    mock.close();
  }
});

test('heal: LLM path refuses a proposal that does not extract the right shape', async () => {
  site.serve('site-v1.html');
  const baseline = await extract({ ...config, url: site.url }, await browser.newPage());

  site.serve('site-v3.html');
  const mock = await startMockLLM(
    '{"items":".does-not-exist","fields":{"name":".title","price":".cost"}}',
  );
  try {
    const result = await heal(
      browser,
      { ...config, url: site.url },
      baseline,
      { llm: { baseUrl: mock.baseUrl } },
    );
    assert.equal(result.repaired, false);
    assert.equal(result.verified, null);
    assert.equal(result.config.items, '.product-card'); // nothing shipped
    assert.ok(result.attempts.some((a) => a.includes('heal-llm: FAIL')));
  } finally {
    mock.close();
  }
});

test('heal: with no LLM configured, a values-change redesign refuses loudly', async () => {
  site.serve('site-v1.html');
  const baseline = await extract({ ...config, url: site.url }, await browser.newPage());

  site.serve('site-v3.html');
  const result = await heal(browser, { ...config, url: site.url }, baseline);
  assert.equal(result.repaired, false);
  assert.equal(result.verified, null);
  assert.ok(
    result.attempts.some((a) => a.includes('no element on the page still contains any known')),
  );
});
