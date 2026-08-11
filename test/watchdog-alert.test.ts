import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { runWatchdog } from '../src/watchdog.js';

const fixture = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', name);
const statePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-alert.json');

const config: ScraperConfig = {
  url: '',
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
};

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
  rmSync(statePath, { force: true });
});

after(async () => {
  await browser.close();
  rmSync(statePath, { force: true });
});

test('watchdog: an unhealable red cycle posts to the webhook and exits 1', async () => {
  const current = { file: fixture('site-v1.html') };
  const site = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current.file));
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const payloads: Record<string, unknown>[] = [];
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      payloads.push(JSON.parse(body) as Record<string, unknown>);
      res.end('ok');
    });
  });
  await new Promise<void>((ok) => hook.listen(0, '127.0.0.1', () => ok()));
  const hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;

  const logs: string[] = [];
  try {
    // Cycle 1 captures the baseline; then the site changes markup AND values,
    // so nothing can be anchored by text and no LLM is configured — the heal
    // refuses, and the alert must fire.
    setTimeout(() => {
      current.file = fixture('site-v3.html');
    }, 400);

    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 2,
      statePath,
      alerts: { webhook: hookUrl },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1, 'an unhealed red run must exit non-zero');
    assert.equal(payloads.length, 1, 'exactly one alert for one red cycle');
    assert.ok(String(payloads[0].target).includes('127.0.0.1'));
    assert.ok(String(payloads[0].summary).includes('cycle'));
    assert.ok(String(payloads[0].at).length > 0);
    assert.ok(logs.some((l) => l.includes('alert sent → webhook')));
  } finally {
    site.close();
    hook.close();
  }
});
