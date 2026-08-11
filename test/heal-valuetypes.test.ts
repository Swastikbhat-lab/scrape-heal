import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { extract } from '../src/scraper.js';
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

/** A stub OpenAI-compatible endpoint serving canned proposals in order. */
function startMockLLMSequence(contents: string[]) {
  let i = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const content = contents[Math.min(i, contents.length - 1)];
      i++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
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

test('heal: text repair refuses to ship when the price selector binds a prose element', async () => {
  site.serve('site-v1.html');
  const baseline = (await extract({ ...config, url: site.url }, await browser.newPage())).items;

  // v5 keeps the names (identity survives the redesign) but hides prices:
  // the old .price element now holds "Price on request" prose, and the real
  // prices moved to .amount with NEW values — so the text matcher finds no
  // anchor for the old price values and keeps the old .price selector.
  site.serve('site-v5.html');

  const result = await heal(browser, { ...config, url: site.url }, baseline);
  assert.equal(result.repaired, false, 'a prose-bound price field must not ship');
  assert.equal(result.verified, null);
  assert.equal(result.config.items, '.product-card', 'nothing may be shipped');

  // The gate refused on the value-type dimension: shape passed, identities
  // present, but the values stopped looking like prices.
  assert.ok(
    result.attempts.some((a) => a.includes('no longer look like a price')),
    `expected the type refusal in attempts, got: ${result.attempts.join('\n')}`,
  );
});

test('heal: LLM repair refuses a wrong price binding, learns, and ships the right one', async () => {
  site.serve('site-v1.html');
  const baseline = (await extract({ ...config, url: site.url }, await browser.newPage())).items;

  // v4 changed the values AND added .badge elements with tempting prose.
  // The model first proposes price → .badge (shape passes — it has text!),
  // which only the value-type gate can catch; then corrects to .cost.
  site.serve('site-v4.html');
  const mock = await startMockLLMSequence([
    '{"items":".tile","fields":{"name":".title","price":".badge"}}',
    '{"items":".tile","fields":{"name":".title","price":".cost"}}',
  ]);
  try {
    const result = await heal(
      browser,
      { ...config, url: site.url },
      baseline,
      { llm: { baseUrl: mock.baseUrl } },
    );
    assert.equal(result.repaired, true);
    assert.equal(result.config.items, '.tile');
    assert.equal(result.config.fields[1].selector, '.cost');

    // Attempt 1 failed on the value-type gate (not on shape), and that
    // failure was fed back before the retry succeeded.
    const attempt1 = result.attempts.find((a) => a.includes('heal-llm: attempt 1 FAILED'));
    assert.ok(attempt1, `expected a failed attempt 1, got: ${result.attempts.join('\n')}`);
    assert.match(attempt1, /no longer look like a price/);
    assert.ok(result.attempts.some((a) => a.includes('heal-llm: attempt 2 PASS')));

    // The shipped repair extracts actual prices, not badges.
    assert.ok(result.verified, 'expected verified rows');
    for (const row of result.verified) {
      assert.match(row.price, /^\$\d/, `expected a $ price, got "${row.price}"`);
    }

    // The miss is remembered so future sessions don't repeat the bad binding.
    assert.ok(result.memory, 'expected per-site memory');
    assert.ok(result.memory.misses.some((m) => m.includes('.badge')));
  } finally {
    mock.close();
  }
});
