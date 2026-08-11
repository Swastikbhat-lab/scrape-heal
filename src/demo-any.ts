import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ScraperConfig, ExtractedItem } from './scraper.js';
import { validate } from './scraper.js';
import { heal } from './heal.js';
import { commandRows } from './source.js';

/**
 * The same loop, with a scraper that is not Playwright.
 *
 * The fixture scraper here is a plain fetch + regex script — the kind that
 * breaks silently on redesigns. The loop treats its *output* exactly like it
 * treats Playwright's: validate against the last good run, and when red, find
 * the new selectors in the browser and verify them. Then it hands the repaired
 * selectors back to the scraper as a JSON config it can read.
 *
 *   npm run demo:any
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fixture = (name: string) => resolve(root, 'fixture', name);
const current = fixture('current.html');
const configPath = resolve(root, '.scrape-heal', 'scraper.config.json');

const config: ScraperConfig = {
  url: '', // filled once the server is up
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
};

const writeConfig = (c: ScraperConfig) => {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    items: c.items,
    fields: c.fields,
    identityField: c.identityField,
    minItems: c.minItems,
  }, null, 2));
};

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync(current));
});
const port = await new Promise<number>((ok) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    ok(typeof addr === 'object' && addr ? addr.port : 0);
  });
});
config.url = `http://127.0.0.1:${port}/`;

const scraperCmd =
  `node ${resolve(root, 'fixture', 'regex-scraper.mjs')} --url=${config.url} --config=${configPath}`;
const rows = commandRows(scraperCmd);

const line = (s = '') => console.log(s);
const step = (s: string) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);
const table = (items: ExtractedItem[]) =>
  items.forEach((it, i) => line(`      ${i + 1}. ${it.name}  |  ${it.price}`));

writeConfig(config);
copyFileSync(fixture('site-v1.html'), current);

step('STEP 1 — a scraper that is NOT Playwright: plain fetch + regex');
line('  (it reads its selectors from a JSON config and prints rows to stdout)');

const good = (await rows()).items ?? [];
const goodCheck = validate(config, good);
line(`  ✓ regex scraper extracted ${goodCheck.itemCount} item(s) — schema OK`);
table(good);
const baseline = good;

step('STEP 2 — the site redeploys. The regex scraper quietly returns nothing.');
copyFileSync(fixture('site-v2.html'), current);

const broken = (await rows()).items ?? [];
const brokenCheck = validate(config, broken, baseline);
line(`  ✗ regex scraper extracted ${brokenCheck.itemCount} item(s) — BROKEN`);
brokenCheck.issues.forEach((i) => line(`    - ${i}`));

step('STEP 3 — the loop wakes up. It still knows what the data looked like.');
const browser = await chromium.launch();
const result = await heal(browser, config, baseline);
result.attempts.forEach((a) => line(`  ${a}`));

if (result.repaired && result.verified) {
  writeConfig(result.config);
  line('');
  line(`  repaired selectors written → .scrape-heal/scraper.config.json`);
  line(`      before: items "${config.items}"  name "${config.fields[0].selector}"  price "${config.fields[1].selector}"`);
  line(`      after:  items "${result.config.items}"  name "${result.config.fields[0].selector}"  price "${result.config.fields[1].selector}"`);
  line('');
  line('  the regex scraper reads its config on every run — no code changes:');

  const healed = (await rows()).items ?? [];
  const healedCheck = validate(result.config, healed, baseline);
  if (healedCheck.ok) {
    line(`  ✓ regex scraper re-extracted ${healedCheck.itemCount} item(s) with the new selectors`);
    table(healed);
    const same = baseline.every(
      (b, i) => b.name === healed[i]?.name && b.price === healed[i]?.price,
    );
    line('');
    line(same
      ? '  ✓ data is identical to the last good run. The loop did not care what the scraper was.'
      : '  ⚠ data differs from baseline — inspect before trusting.');
  } else {
    line(`  ✗ ${healedCheck.issues.join('; ')}`);
  }
} else {
  step('NO REPAIR — nothing was shipped');
}

await browser.close();
server.close();
console.log(`\n  demo finished — served on 127.0.0.1:${port}\n`);
