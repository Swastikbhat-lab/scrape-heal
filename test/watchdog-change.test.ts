import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { runWatchdog } from '../src/watchdog.js';

const statePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-change.json');

const config: ScraperConfig = {
  url: '',
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
    { name: 'stock', selector: '.stock' },
  ],
  identityField: 'name',
  minItems: 4,
};

const page = (priceA = '$24.99', stockA = 'in stock', stockB = 'in stock') => `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
  <div class="product-card"><div class="name">Wireless Mouse</div><div class="price">${priceA}</div><div class="stock">${stockA}</div></div>
  <div class="product-card"><div class="name">Mechanical Keyboard</div><div class="price">$89.00</div><div class="stock">${stockB}</div></div>
  <div class="product-card"><div class="name">USB-C Hub</div><div class="price">$39.99</div><div class="stock">in stock</div></div>
  <div class="product-card"><div class="name">Laptop Stand</div><div class="price">$29.00</div><div class="stock">in stock</div></div>
</body></html>`;

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
  rmSync(statePath, { force: true });
});

after(async () => {
  await browser.close();
  rmSync(statePath, { force: true });
});

test('watchdog: a healthy cycle with a price drop is diffed and alerted on threshold', async () => {
  const current = { html: page() };
  const site = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(current.html);
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
    // Cycle 1 captures the baseline. Then the site drops the Mouse's price
    // (a 20% drop — well past the 5% threshold) and flips the Keyboard to
    // out of stock — but all identities survive, so both cycles are healthy.
    setTimeout(() => {
      current.html = page('$19.99', 'in stock', 'out of stock');
    }, 400);

    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 2,
      statePath,
      alerts: { webhook: hookUrl, onChange: true, changeCooldownMinutes: 0 },
      watch: {
        enabled: true,
        thresholds: [
          { field: 'price', dropPercent: 5 },
          { field: 'stock', changedTo: 'out of stock' },
        ],
      },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 0, 'both cycles are healthy — change alerts are not breakage');
    assert.ok(logs.some((l) => l.includes('changes vs the last good run')), 'the diff is logged');
    assert.ok(logs.some((l) => l.includes('$24.99') && l.includes('$19.99')), 'the price change is in the log');
    assert.ok(logs.some((l) => l.includes('change alert sent')), 'the change alert fired');

    assert.equal(payloads.length, 1, 'one change alert for one changed cycle');
    const msg = payloads[0];
    assert.ok(String(msg.summary).includes('price dropped ≥ 5%'));
    assert.ok(String(msg.summary).includes('stock became "out of stock"'));
    assert.ok(String(msg.summary).includes('Mouse'));
    assert.ok(String(msg.summary).includes('Keyboard'));

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastChanges?: { added: number; removed: number; changed: number };
    };
    assert.ok(saved.lastChanges, 'the change report persists in state');
    assert.equal(saved.lastChanges.added, 0);
    assert.equal(saved.lastChanges.removed, 0);
    assert.equal(saved.lastChanges.changed, 2);
  } finally {
    site.close();
    hook.close();
  }
});

test('watchdog: no threshold configured means every change alerts', async () => {
  const current = { html: page() };
  const site = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(current.html);
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
    setTimeout(() => {
      current.html = page('$19.99');
    }, 400);

    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 2,
      statePath,
      alerts: { webhook: hookUrl, onChange: true, changeCooldownMinutes: 0 },
      watch: { enabled: true, thresholds: [] },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 0);
    assert.equal(payloads.length, 1, 'no thresholds → any change alerts');
    assert.ok(String(payloads[0].summary).includes('data changed'));
  } finally {
    site.close();
    hook.close();
  }
});
