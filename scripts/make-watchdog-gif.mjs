/**
 * Renders `npm run watch` (watchdog mode) as a terminal-style animated GIF
 * (docs/watchdog.gif) — the loop on a cadence: OK → OK → RED → REPAIRED → OK.
 *
 *   node scripts/make-watchdog-gif.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTerminalGif, C } from './gif-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'docs', 'watchdog.gif');

const transcript = [
  { t: 0.0, d: 2.2, c: C.cmd, s: '$ npm run watch -- --demo --mutate 20 --interval 10' },
  { t: 2.7, d: 0.1, c: C.dim, s: '  watching http://127.0.0.1:39519/ every 10s for 6 cycle(s)' },
  { t: 3.1, d: 0.1, c: C.dim, s: '  config → scraper.config.json' },
  { t: 3.5, d: 0.1, c: C.dim, s: '  state  → .scrape-heal/state.json' },
  { t: 4.3, d: 0.1, c: C.green, s: '[cycle 1] OK — 4 item(s), shape matches the last good run (baseline captured)' },
  { t: 5.6, d: 0.1, c: C.green, s: '[cycle 2] OK — 4 item(s), shape matches the last good run' },
  { t: 7.2, d: 0.1, c: C.yellow, s: '  [mutate] the site redeployed overnight — new markup is live' },
  { t: 8.6, d: 0.15, c: C.red, s: '[cycle 3] RED — expected at least 4 item(s), got 0' },
  { t: 9.9, d: 0.6, c: C.cmd, s: '[cycle 3] REPAIRED — ".item" + name:"h2.title", price:"span.amount"' },
  { t: 11.2, d: 0.3, c: C.cmd, s: '  config written → scraper.config.json' },
  { t: 12.4, d: 0.35, c: C.green, s: '[cycle 4] OK — 4 item(s), shape matches the last good run' },
  { t: 13.8, d: 0.35, c: C.green, s: '[cycle 5] OK — 4 item(s), shape matches the last good run' },
  { t: 15.2, d: 0.35, c: C.green, s: '[cycle 6] OK — 4 item(s), shape matches the last good run' },
  { t: 17.0, d: 0.5, c: C.dim, s: '  The loop runs forever. A broken run repairs itself, or alerts.' },
];

await renderTerminalGif({
  transcript,
  out: OUT,
  title: 'scrape-heal — npm run watch (watchdog)',
  total: 24,
  verify: [
    '[cycle 3] RED — expected at least 4 item(s), got 0',
    '[cycle 3] REPAIRED — ".item"',
    '[cycle 6] OK — 4 item(s)',
    'repairs itself, or alerts',
  ],
});
