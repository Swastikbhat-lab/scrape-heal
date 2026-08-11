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
// The drop-in adapters, exactly as a user would import them (in-repo path;
// from npm they'd import the same helpers from 'scrape-heal'). They are plain
// JS on purpose (copy-paste templates), so the typed test shrugs at them.
// @ts-ignore -- plain-JS adapter, no declaration file
import { scrapeWithSelfHealing } from '../integrations/playwright.mjs';
// @ts-ignore -- plain-JS adapter, no declaration file
import { withSelfHealing } from '../integrations/crawlee.mjs';

const fixture = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', name);

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
        serve: (name) => { current.file = fixture(name); },
        close: () => server.close(),
      });
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

test('playwright adapter: extracts, detects the redesign, heals, and returns fixed rows', async () => {
  const page = await browser.newPage();
  try {
    site.serve('site-v1.html');
    const lastGoodRows = (await extract({ ...config, url: site.url }, page)).items;
    assert.equal(lastGoodRows.length, 4);

    // The site redesigns; the script's selectors now return nothing.
    site.serve('site-v2.html');

    const { rows, config: fixed, repaired, issues } = await scrapeWithSelfHealing({
      browser,
      config: { ...config, url: site.url },
      extractRows: async () => (await extract({ ...config, url: site.url }, page)).items,
      lastGoodRows,
    });

    assert.equal(repaired, true, issues?.join('; '));
    assert.equal(rows.length, 4);
    assert.equal(fixed.items, '.item');
    assert.ok(fixed.fields[1].selector.includes('amount'), JSON.stringify(fixed.fields));
  } finally {
    await page.close();
  }
});

test('crawlee adapter: same story through the per-request guard', async () => {
  const page = await browser.newPage();
  try {
    site.serve('site-v1.html');
    const lastGoodRows = (await extract({ ...config, url: site.url }, page)).items;

    const guard = withSelfHealing({
      config: { ...config, url: site.url },
      lastGoodRows,
      getBrowser: async () => browser,
    });

    site.serve('site-v2.html');
    const broken = (await extract({ ...config, url: site.url }, page)).items;
    assert.equal(broken.length, 0);

    const { rows, config: fixed, repaired, issues } = await guard(broken);
    assert.equal(repaired, true, issues?.join('; '));
    assert.equal(rows.length, 4);
    assert.equal(fixed.items, '.item');
  } finally {
    await page.close();
  }
});

test('crawlee adapter: a healthy page passes through untouched (no heal)', async () => {
  const page = await browser.newPage();
  try {
    site.serve('site-v1.html');
    const rows = (await extract({ ...config, url: site.url }, page)).items;

    const guard = withSelfHealing({
      config: { ...config, url: site.url },
      lastGoodRows: rows,
      getBrowser: async () => browser,
    });

    const out = await guard(rows);
    assert.equal(out.repaired, false, 'nothing broke — the guard must not heal');
    assert.equal(out.config.items, '.product-card');
  } finally {
    await page.close();
  }
});
