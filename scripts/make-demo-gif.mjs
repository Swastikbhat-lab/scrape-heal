/**
 * Renders `npm run demo` as a terminal-style animated GIF (docs/demo.gif).
 *
 *   node scripts/make-demo-gif.mjs        ->  docs/demo.gif
 *   GIF_VERIFY=1 node scripts/make-demo-gif.mjs   (assert the story landed)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTerminalGif, C } from './gif-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'docs', 'demo.gif');

// The story, timed. `t` = start (s), `d` = typing duration (s), `c` = color.
const transcript = [
  { t: 0.0, d: 2.2, c: C.cmd, s: '$ npm run demo' },
  { t: 2.6, d: 0.1, c: C.dim, s: '┌──────────────────────────────────────────────────────────┐' },
  { t: 2.8, d: 0.1, c: C.cyan, s: 'STEP 1 — the site is healthy, the scraper works' },
  { t: 3.4, d: 0.1, c: C.green, s: '  ✓ extracted 4 item(s) — schema OK' },
  { t: 3.9, d: 0.25, c: C.cmd, s: '      1. Wireless Mouse        |  $24.99' },
  { t: 4.3, d: 0.25, c: C.cmd, s: '      2. Mechanical Keyboard   |  $89.00' },
  { t: 4.7, d: 0.25, c: C.cmd, s: '      3. USB-C Hub             |  $39.50' },
  { t: 5.1, d: 0.25, c: C.cmd, s: '      4. 4K Monitor            |  $299.00' },
  { t: 5.8, d: 0.1, c: C.cyan, s: 'STEP 2 — the site redeploys overnight. Nobody tells the scraper.' },
  { t: 6.3, d: 0.1, c: C.red, s: '  ✗ extracted 0 item(s) — BROKEN' },
  { t: 6.7, d: 0.3, c: C.yellow, s: '    - expected at least 4 item(s), got 0' },
  { t: 7.1, d: 0.3, c: C.yellow, s: '    - missing known value(s): Wireless Mouse, Mechanical Keyboard, …' },
  { t: 7.8, d: 0.1, c: C.cyan, s: 'STEP 3 — the healer wakes up. It knows what the data used to look like.' },
  { t: 8.3, d: 0.5, c: C.cmd, s: '  heal: item container candidate ".item" — 4 match(es)' },
  { t: 9.0, d: 0.5, c: C.cmd, s: '  heal: field "name" — candidate "h2.title" (4 match(es))' },
  { t: 9.7, d: 0.5, c: C.cmd, s: '  heal: field "price" — candidate "span.amount" (4 match(es))' },
  { t: 10.4, d: 0.6, c: C.cmd, s: '  heal: verifying on the live page…' },
  { t: 11.2, d: 0.3, c: C.green, s: '  heal: PASS — 4 item(s), every known "name" present. Shipping the repair.' },
  { t: 12.2, d: 0.1, c: C.cyan, s: 'STEP 4 — repaired, and only because verification passed' },
  { t: 12.7, d: 0.3, c: C.cmd, s: '  new config: items ".item"' },
  { t: 13.2, d: 0.3, c: C.cmd, s: '              name -> "h2.title"    price -> "span.amount"' },
  { t: 13.9, d: 0.25, c: C.cmd, s: '      1. Wireless Mouse        |  $24.99' },
  { t: 14.3, d: 0.25, c: C.cmd, s: '      2. Mechanical Keyboard   |  $89.00' },
  { t: 14.7, d: 0.25, c: C.cmd, s: '      3. USB-C Hub             |  $39.50' },
  { t: 15.1, d: 0.25, c: C.cmd, s: '      4. 4K Monitor            |  $299.00' },
  { t: 15.9, d: 0.4, c: C.green, s: '  ✓ data is identical to the last good run — nothing lost, nothing invented.' },
  { t: 16.7, d: 0.6, c: C.dim, s: '  If verification had failed, nothing would have been shipped.' },
];

await renderTerminalGif({
  transcript,
  out: OUT,
  title: 'scrape-heal — npm run demo',
  total: 24, // typing finishes ~17.5s, then a hold so readers can read the ending
  verify: [
    'STEP 4 — repaired, and only because verification passed',
    'PASS — 4 item(s)',
    'identical to the last good run',
    'nothing would have been shipped',
  ],
});
