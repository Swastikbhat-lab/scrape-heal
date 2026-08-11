import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { runWatchdog } from '../src/watchdog.js';

const fixture = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', name);
const statePath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', name);

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

/** A webhook capture server — records every payload. */
function startHook() {
  const payloads: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      payloads.push(JSON.parse(body) as Record<string, unknown>);
      res.end('ok');
    });
  });
  return new Promise<{ url: string; close: () => void; payloads: typeof payloads }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/hook`, close: () => server.close(), payloads });
    });
  });
}

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
});

test('watchdog: a transient 503 is retried with backoff and the cycle still succeeds', async () => {
  const state = statePath('test-classify-transient-recover.json');
  rmSync(state, { force: true });

  // The site 503s exactly once, then serves the real page — like a deploy
  // window or an overloaded origin. The loop must retry, not heal, not alert.
  let hits = 0;
  const site = createServer((_q, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('Service Unavailable');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(fixture('site-v1.html')));
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const logs: string[] = [];
  try {
    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 1,
      statePath: state,
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 0, 'the cycle recovers after the transient');
    assert.ok(logs.some((l) => l.includes('transient fetch failure')), 'the retry is logged');
    assert.ok(logs.some((l) => l.includes('[cycle 1] OK')), 'the cycle ends healthy');
    assert.ok(!logs.some((l) => l.includes('heal:')), 'a transient is never healed');
    assert.ok(!logs.some((l) => l.includes('ALERT')), 'a recovered transient never alerts');
  } finally {
    site.close();
  }
});

test('watchdog: a persistent 503 ends red, alerts, and never heals', async () => {
  const state = statePath('test-classify-transient-persist.json');
  rmSync(state, { force: true });

  const site = createServer((_q, res) => {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('Service Unavailable');
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const hook = await startHook();
  const logs: string[] = [];
  try {
    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 1,
      statePath: state,
      maxFetchAttempts: 2,
      alerts: { webhook: hook.url, cooldownMinutes: 0 },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1, 'an unreachable site is red, not healthy');
    assert.equal(hook.payloads.length, 1, 'the human is alerted');
    assert.ok(String(hook.payloads[0].summary).includes('failed to respond'));
    assert.ok(logs.some((l) => l.includes('This is not a site change')), 'the loop says so plainly');
    assert.ok(!logs.some((l) => l.includes('heal:')), 'a dead site is never healed');

    const saved = JSON.parse(readFileSync(state, 'utf8')) as { lastStatus?: string };
    assert.equal(saved.lastStatus, 'red');
  } finally {
    site.close();
    hook.close();
  }
});

test('watchdog: a 403 block without a proxy pool alerts and never heals', async () => {
  const state = statePath('test-classify-block.json');
  rmSync(state, { force: true });

  const site = createServer((_q, res) => {
    res.writeHead(403);
    res.end('Forbidden');
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const hook = await startHook();
  const logs: string[] = [];
  try {
    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 1,
      statePath: state,
      alerts: { webhook: hook.url, cooldownMinutes: 0 },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1);
    assert.equal(hook.payloads.length, 1);
    const summary = String(hook.payloads[0].summary);
    assert.ok(summary.includes('blocked'), 'the alert names the block');
    assert.ok(summary.includes('configure "proxy"'), 'the alert points at the fix');
    assert.ok(!logs.some((l) => l.includes('heal:')), 'a block is never healed');
  } finally {
    site.close();
    hook.close();
  }
});

test('watchdog: an anti-bot wall that answers 200 is classified as a block, not breakage', async () => {
  const state = statePath('test-classify-captcha.json');
  rmSync(state, { force: true });

  const site = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body>Just a moment... Checking your browser before accessing this site.</body></html>');
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const hook = await startHook();
  const logs: string[] = [];
  try {
    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 1,
      statePath: state,
      alerts: { webhook: hook.url, cooldownMinutes: 0 },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1);
    assert.ok(String(hook.payloads[0].summary).includes('blocked'));
    assert.ok(!logs.some((l) => l.includes('heal:')), 'a captcha wall is never healed as breakage');
  } finally {
    site.close();
    hook.close();
  }
});

test('watchdog: a blocked proxy is cooled down and the loop rotates to the next one', async () => {
  const state = statePath('test-classify-proxy-rotate.json');
  rmSync(state, { force: true });

  // The site itself is fine.
  const site = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(fixture('site-v1.html')));
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  // Proxy A always 403s — the "bad" proxy. Proxy B forwards to the site.
  const proxyA = createServer((_q, res) => {
    res.writeHead(403);
    res.end('Forbidden');
  });
  await new Promise<void>((ok) => proxyA.listen(0, '127.0.0.1', () => ok()));
  const proxyAUrl = `http://127.0.0.1:${(proxyA.address() as { port: number }).port}`;

  const proxyB = createServer(async (req, res) => {
    try {
      // Forward to the site; the host header must reflect the site, not this proxy.
      const headers = { ...req.headers };
      delete headers.host;
      const up = await fetch(req.url!, { headers: headers as Record<string, string> });
      res.writeHead(up.status, Object.fromEntries(up.headers));
      Readable.fromWeb(up.body as never).pipe(res);
    } catch {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });
  await new Promise<void>((ok) => proxyB.listen(0, '127.0.0.1', () => ok()));
  const proxyBUrl = `http://127.0.0.1:${(proxyB.address() as { port: number }).port}`;

  const logs: string[] = [];
  try {
    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 1,
      statePath: state,
      // Pool round-robin starts at index 1, so the *blocking* proxy goes
      // second: attempt 1 hits it, gets cooled, and attempt 2 rotates to B.
      proxy: { proxies: [proxyBUrl, proxyAUrl] },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 0, 'the loop recovers by rotating to a healthy proxy');
    assert.ok(logs.some((l) => l.includes('proxy ' + proxyAUrl + ' blocked')), 'the bad proxy is named and cooled');
    assert.ok(logs.some((l) => l.includes('rotating')), 'rotation is logged');
    assert.ok(logs.some((l) => l.includes('[cycle 1] OK')), 'the cycle ends healthy through the good proxy');
    assert.ok(!logs.some((l) => l.includes('heal:')), 'a block is a rotation problem, never a heal');
  } finally {
    site.close();
    proxyA.close();
    proxyB.close();
  }
});
