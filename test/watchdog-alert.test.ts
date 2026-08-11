import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { runWatchdog, alertThrottled } from '../src/watchdog.js';

const fixture = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', name);
const statePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-alert.json');
const statePathThrottle = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-alert-throttle.json');
const statePathNoCool = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-alert-nocool.json');

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
  for (const p of [statePath, statePathThrottle, statePathNoCool]) rmSync(p, { force: true });
});

after(async () => {
  await browser.close();
  for (const p of [statePath, statePathThrottle, statePathNoCool]) rmSync(p, { force: true });
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

test('alertThrottled: the cooldown gate', () => {
  const now = '2026-08-11T12:00:00.000Z';
  const mins = (m: number) => new Date(Date.parse(now) - m * 60_000).toISOString();
  assert.equal(alertThrottled(undefined, 60, now), false, 'no prior alert → not throttled');
  assert.equal(alertThrottled(mins(1), 0, now), false, 'cooldown 0 → never throttled');
  assert.equal(alertThrottled(mins(1), 60, now), true, 'alert 1 min ago, cooldown 60 → throttled');
  assert.equal(alertThrottled(mins(61), 60, now), false, 'alert 61 min ago, cooldown 60 → allowed again');
  assert.equal(alertThrottled('not-a-date', 60, now), false, 'corrupt timestamp → never blocks');
});

test('watchdog: a broken target alerts at most once per cooldown window', async () => {
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
    // Break after the baseline: cycles 2 and 3 are both red, but a 10-minute
    // cooldown means only cycle 2 may alert — cycle 3 must be throttled.
    setTimeout(() => {
      current.file = fixture('site-v3.html');
    }, 400);

    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 3,
      statePath: statePathThrottle,
      alerts: { webhook: hookUrl, cooldownMinutes: 10 },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1, 'the target ended red');
    assert.equal(payloads.length, 1, 'two red cycles, one alert — the second was throttled');
    assert.ok(logs.some((l) => l.includes('alert throttled')), 'the throttled cycle says so in the log');

    const saved = JSON.parse(readFileSync(statePathThrottle, 'utf8')) as { lastAlertAt?: string };
    assert.ok(typeof saved.lastAlertAt === 'string', 'the cooldown timestamp persists in state');
  } finally {
    site.close();
    hook.close();
  }
});

test('watchdog: cooldownMinutes 0 disables throttling — every red cycle alerts', async () => {
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
    setTimeout(() => {
      current.file = fixture('site-v3.html');
    }, 400);

    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 3,
      statePath: statePathNoCool,
      alerts: { webhook: hookUrl, cooldownMinutes: 0 },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1, 'the target ended red');
    assert.equal(payloads.length, 2, 'cooldown 0 → both red cycles alert');
    assert.ok(!logs.some((l) => l.includes('alert throttled')), 'no throttling when disabled');
  } finally {
    site.close();
    hook.close();
  }
});
