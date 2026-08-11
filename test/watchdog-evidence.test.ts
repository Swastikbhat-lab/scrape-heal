import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { runWatchdog } from '../src/watchdog.js';
import { startDashboard } from '../src/dashboard.js';

const fixture = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', name);
const statePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-evidence-watch.json');
const stateDir = dirname(statePath);

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
  rmSync(statePath, { force: true });
  rmSync(join(stateDir, 'evidence'), { recursive: true, force: true });
});

after(async () => {
  await browser.close();
  rmSync(statePath, { force: true });
  rmSync(join(stateDir, 'evidence'), { recursive: true, force: true });
});

test('watchdog: an unhealed breakage captures screenshot + DOM and attaches them to the alert', async () => {
  const current = { file: fixture('site-v1.html') };
  const site = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current.file));
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const hook = await startHook();
  const logs: string[] = [];
  try {
    // Cycle 1 captures the baseline; then the site changes markup AND values,
    // so no repair is possible without an LLM — the cycle ends red with
    // evidence of what the page looked like.
    setTimeout(() => {
      current.file = fixture('site-v3.html');
    }, 400);

    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 2,
      statePath,
      alerts: { webhook: hook.url, cooldownMinutes: 0 },
      log: (line) => logs.push(line),
    }, { ...config, url: siteUrl });

    assert.equal(code, 1, 'the unhealed breakage is red');
    assert.equal(hook.payloads.length, 1);

    const evidence = hook.payloads[0].evidence as {
      screenshot?: string; dom?: string; reason: string; status?: number;
    } | undefined;
    assert.ok(evidence, 'the alert carries evidence');
    assert.ok(evidence.screenshot, 'a screenshot path is attached');
    assert.ok(evidence.dom, 'a DOM snapshot path is attached');
    assert.ok(evidence.reason.includes('expected at least 4'), 'the reason explains the red');

    assert.ok(existsSync(join(stateDir, evidence.screenshot)), 'the screenshot file exists');
    assert.ok(existsSync(join(stateDir, evidence.dom)), 'the DOM file exists');
    const dom = readFileSync(join(stateDir, evidence.dom), 'utf8');
    assert.ok(dom.includes('Wireless Mouse') === false, 'the DOM is the redesigned page, not the baseline');
    assert.ok(logs.some((l) => l.includes('evidence → ')), 'the log names the evidence');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastEvidence?: { screenshot?: string };
    };
    assert.ok(saved.lastEvidence?.screenshot, 'evidence persists in state');
  } finally {
    site.close();
    hook.close();
  }
});

test('watchdog: a 403 block captures evidence with the HTTP status', async () => {
  const site = createServer((_q, res) => {
    res.writeHead(403);
    res.end('Forbidden');
  });
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', () => ok()));
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

  const hook = await startHook();
  try {
    const code = await runWatchdog(browser, await browser.newPage(), {
      intervalSeconds: 1,
      cycles: 1,
      statePath,
      alerts: { webhook: hook.url, cooldownMinutes: 0 },
      log: () => {},
    }, { ...config, url: siteUrl });

    assert.equal(code, 1);
    const evidence = hook.payloads[0].evidence as { status?: number; screenshot?: string } | undefined;
    assert.ok(evidence, 'a block also keeps evidence');
    assert.equal(evidence.status, 403, 'the status is captured');
    assert.ok(evidence.screenshot && existsSync(join(stateDir, evidence.screenshot)), 'the block page is screenshotted');
  } finally {
    site.close();
    hook.close();
  }
});

test('dashboard: serves captured evidence and includes it in /state', async () => {
  // A dedicated state dir — the shared one fills up with other tests' files.
  const dashDir = join(stateDir, 'test-evidence-dash');
  rmSync(dashDir, { recursive: true, force: true });
  mkdirSync(dashDir, { recursive: true });
  const evDir = join(dashDir, 'evidence', 'demo-target');
  mkdirSync(evDir, { recursive: true });
  writeFileSync(join(evDir, 'x_screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(evDir, 'x_dom.html'), '<html><body>red</body></html>');
  writeFileSync(join(dashDir, 'demo-target.json'), JSON.stringify({
    config: {
      url: 'http://127.0.0.1:1/', items: '.product-card',
      fields: [{ name: 'name', selector: '.name' }],
      identityField: 'name', minItems: 4,
    },
    baseline: [],
    ledger: [],
    llmMemory: {},
    lastStatus: 'red',
    lastCheckedAt: new Date().toISOString(),
    alertCount: 1,
    lastEvidence: {
      at: new Date().toISOString(),
      reason: 'blocked (HTTP 403)',
      status: 403,
      screenshot: 'evidence/demo-target/x_screenshot.png',
      dom: 'evidence/demo-target/x_dom.html',
    },
  }));

  const dash = await startDashboard({ stateDir: dashDir, port: 0, pollMs: 10_000 });
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const shot = await fetch(`${base}/evidence/demo-target/x_screenshot.png`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/png');
    const shotBytes = Buffer.from(await shot.arrayBuffer());
    assert.deepEqual([...shotBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const dom = await fetch(`${base}/evidence/demo-target/x_dom.html`);
    assert.equal(dom.status, 200);
    assert.ok((dom.headers.get('content-type') ?? '').includes('text/html'));

    const st = await (await fetch(`${base}/state`)).json() as { lastEvidence?: { reason: string; status: number } }[];
    assert.equal(st.length, 1);
    assert.equal(st[0].lastEvidence?.reason, 'blocked (HTTP 403)');
    assert.equal(st[0].lastEvidence?.status, 403);

    // The page itself references the evidence route.
    const page = await (await fetch(base + '/')).text();
    assert.ok(page.includes('/evidence/'), 'the board links evidence into the page');
  } finally {
    await dash.close();
  }
});
