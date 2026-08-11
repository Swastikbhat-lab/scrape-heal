import { copyFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ScraperConfig, ExtractedItem } from './scraper.js';
import { extract, validate } from './scraper.js';
import { heal } from './heal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fixture = (name: string) => resolve(root, 'fixture', name);
const current = fixture('current.html');

const config: ScraperConfig = {
  url: '', // filled in once the server is up
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
};

function table(items: ExtractedItem[]): string[] {
  const names = config.fields.map((f) => f.name);
  return items.map((it, i) => `      ${i + 1}. ${names.map((n) => it[n] ?? '').join('  |  ')}`);
}

function identical(a: ExtractedItem[], b: ExtractedItem[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((it) => [it[config.identityField], it]));
  return a.every((it) => {
    const other = byId.get(it[config.identityField]);
    if (!other) return false;
    return config.fields.every((f) => (it[f.name] ?? '').trim() === (other[f.name] ?? '').trim());
  });
}

// A tiny static server that re-reads the file on every request, so swapping
// fixture/current.html is enough to make the "site" change under us.
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync(current));
});

const port = await new Promise<number>((resolvePort) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolvePort(typeof addr === 'object' && addr ? addr.port : 0);
  });
});
config.url = `http://127.0.0.1:${port}/`;

const line = (s = '') => console.log(s);
const step = (s: string) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

step('STEP 1 — the site is healthy, the scraper works');
copyFileSync(fixture('site-v1.html'), current);

const browser = await chromium.launch();
const page = await browser.newPage();

const good = await extract(config, page);
const goodCheck = validate(config, good);
line(`  ✓ extracted ${goodCheck.itemCount} item(s) — schema OK`);
table(good).forEach((r) => line(r));
const baseline = good;

step('STEP 2 — the site redeploys overnight. Nobody tells the scraper.');
copyFileSync(fixture('site-v2.html'), current);
line('  (class names renamed, markup restructured — a normal Tuesday)');

const broken = await extract(config, page);
const brokenCheck = validate(config, broken, baseline);
line(`  ✗ extracted ${brokenCheck.itemCount} item(s) — BROKEN`);
brokenCheck.issues.forEach((i) => line(`    - ${i}`));

step('STEP 3 — the healer wakes up. It knows what the data used to look like.');
const result = await heal(browser, config, baseline);
result.attempts.forEach((a) => line(`  ${a}`));

if (result.repaired && result.verified) {
  step('STEP 4 — repaired, and only because verification passed');
  line(`  new config: items "${result.config.items}"`);
  result.config.fields.forEach((f) => line(`              ${f.name} -> "${f.selector}"`));
  line('');
  line('  re-extracted from the live page, post-repair:');
  table(result.verified).forEach((r) => line(r));

  const same = identical(baseline, result.verified);
  line('');
  line(same
    ? '  ✓ data is identical to the last good run — nothing lost, nothing invented.'
    : '  ⚠ data differs from baseline — inspect before trusting (verification still passed).');
  line('');
  line('  If verification had failed, nothing would have been shipped.');
} else {
  step('NO REPAIR — nothing was shipped');
  line('  The loop refuses to guess. That is the point.');
}

await browser.close();
server.close();
console.log(`\n  demo finished — served on 127.0.0.1:${port}\n`);
