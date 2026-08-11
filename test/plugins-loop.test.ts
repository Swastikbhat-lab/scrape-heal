import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { registerPlugin, unregisterPlugin } from '../src/plugins.js';
import { runWatchdog } from '../src/watchdog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string) => resolve(root, 'fixture', name);
const statePath = resolve(root, '.scrape-heal', 'test-plugins-watch.json');

/** One local server whose HTML can be swapped between tests. */
function startSite() {
  const current = { html: '' };
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(current.html);
  });
  return new Promise<{ url: string; serve: (html: string) => void; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({
        url: `http://127.0.0.1:${port}/`,
        serve: (html) => { current.html = html; },
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
let site: { url: string; serve: (html: string) => void; close: () => void };

before(async () => {
  browser = await chromium.launch();
  site = await startSite();
});

after(async () => {
  await browser.close();
  site.close();
});

const usedStates = new Set<string>();

/**
 * One watchdog run. Each unique `name` starts fresh; passing the same name
 * twice continues from the persisted state — exactly how a real watchdog
 * carries its baseline across cycles and restarts.
 */
async function runOnce(
  cycles: number,
  name = `run-${usedStates.size}`,
): Promise<{ code: number; lines: string[]; state: any }> {
  const path = resolve(root, '.scrape-heal', `test-plugins-${name}.json`);
  if (!usedStates.has(name)) {
    rmSync(path, { force: true });
    usedStates.add(name);
  }
  const page = await browser.newPage();
  const lines: string[] = [];
  try {
    const code = await runWatchdog(browser, page, {
      intervalSeconds: 1,
      cycles,
      statePath: path,
      log: (l) => lines.push(l),
    }, { ...config, url: site.url });
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return { code, lines, state };
  } finally {
    await page.close();
  }
}

test('watchdog: extractor plugins produce the rows ahead of the built-in extractor', async () => {
  registerPlugin({
    name: 'json-extractor',
    kind: 'extractor',
    match: (url) => url.includes('127.0.0.1'),
    extract: async (page) => {
      const raw = await page.evaluate(() => document.querySelector('#data')?.textContent ?? 'null');
      try {
        const rows = JSON.parse(raw);
        return Array.isArray(rows) && rows.length ? rows : null;
      } catch {
        return null;
      }
    },
  });
  try {
    // The page has NO elements the CSS config could extract — only a JSON
    // blob the plugin knows how to read.
    site.serve(`<!DOCTYPE html><html><body><script id="data" type="application/json">[
      {"name":"Alpha","price":"$1.00","src":"json"},
      {"name":"Beta","price":"$2.00","src":"json"},
      {"name":"Gamma","price":"$3.00","src":"json"},
      {"name":"Delta","price":"$4.00","src":"json"}
    ]</script></body></html>`);

    const { code, state } = await runOnce(1);
    assert.equal(code, 0);
    assert.equal(state.baseline.length, 4);
    assert.equal(state.baseline[0].src, 'json', 'rows must come from the plugin, not the CSS extractor');
    assert.equal(state.baseline[0].name, 'Alpha');
  } finally {
    unregisterPlugin('json-extractor');
  }
});

test('watchdog: an extractor that falls through lets the built-in extractor run', async () => {
  registerPlugin({
    name: 'null-extractor',
    kind: 'extractor',
    extract: async () => null,
  });
  try {
    site.serve(readFileSync(fixture('site-v1.html'), 'utf8'));
    const { code, state } = await runOnce(1);
    assert.equal(code, 0);
    assert.equal(state.baseline.length, 4);
    assert.equal(state.baseline[0].name, 'Wireless Mouse');
    assert.equal(state.baseline[0].src, undefined, 'the built-in extractor produced the rows');
  } finally {
    unregisterPlugin('null-extractor');
  }
});

test('watchdog: a healer plugin repairs a redesign ahead of the built-in healer', async () => {
  registerPlugin({
    name: 'acme-healer',
    kind: 'healer',
    match: (url) => url.includes('127.0.0.1'),
    heal: async (page, cfg, baseline) => {
      // Site-specific knowledge: Acme renames .product-card → .item etc.
      if (await page.locator('.item').count() < cfg.minItems) return null;
      return {
        config: {
          ...cfg,
          items: '.item',
          fields: [
            { name: 'name', selector: '.title' },
            { name: 'price', selector: '.amount' },
          ],
        },
        verified: baseline,
      };
    },
  });
  try {
    site.serve(readFileSync(fixture('site-v1.html'), 'utf8'));
    const { code, lines } = await runOnce(1, 'heal');
    assert.equal(code, 0, lines.join('\n'));

    // The site redesigns; the next run (same persisted state) must be
    // repaired by the plugin, verified.
    site.serve(readFileSync(fixture('site-v2.html'), 'utf8'));
    const { code: code2, lines: lines2, state: state2 } = await runOnce(1, 'heal');
    assert.equal(code2, 0, lines2.join('\n'));
    assert.ok(lines2.some((l) => l.includes('PLUGIN HEALED')), lines2.join('\n'));
    assert.ok(lines2.some((l) => l.includes('verify gate confirmed')), lines2.join('\n'));
    assert.equal(state2.config.items, '.item');
    assert.equal(state2.baseline.length, 4);
    // The built-in healer never ran, and the ledger had nothing to offer.
    assert.ok(!lines2.some((l) => l.includes('heal: ') || l.includes('heal-llm:') || l.includes('LEDGER HIT')), lines2.join('\n'));
  } finally {
    unregisterPlugin('acme-healer');
  }
});

test('watchdog: a healer plugin whose claim fails the verify gate falls through to the built-in healer', async () => {
  registerPlugin({
    name: 'wrong-healer',
    kind: 'healer',
    heal: async (page, cfg) => ({
      config: { ...cfg, items: '.does-not-exist', fields: cfg.fields },
      verified: [],
    }),
  });
  try {
    site.serve(readFileSync(fixture('site-v1.html'), 'utf8'));
    await runOnce(1, 'refuse'); // baseline

    site.serve(readFileSync(fixture('site-v2.html'), 'utf8'));
    const { code, lines, state } = await runOnce(1, 'refuse');
    assert.equal(code, 0, lines.join('\n'));
    // The plugin's claim extracted nothing — the gate refused it, and the
    // built-in healer did the job instead.
    assert.ok(!lines.some((l) => l.includes('PLUGIN HEALED')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('heal: PASS')), lines.join('\n'));
    assert.equal(state.config.items, '.item');
  } finally {
    unregisterPlugin('wrong-healer');
  }
});
