import { copyFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ScraperConfig } from './scraper.js';
import { runWatchdog } from './watchdog.js';
import { commandRows, fileRows, type RowFetch } from './source.js';

/**
 * Watchdog mode: run the detect → heal → verify loop on a cadence.
 *
 *   npm run watch -- --demo --mutate 12 --interval 5 --cycles 8
 *   npm run watch -- --url http://localhost:5173 --items .card \
 *     --fields name=.name,price=.price --min 4 --identity name --interval 300
 *
 * A cycle that breaks AND cannot be verified-repaired exits non-zero, so a
 * scheduler (cron, CI) sees it. Pass --on-alert "cmd" to run something (a
 * webhook, a desktop notification) the moment a cycle goes red.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fixture = (name: string) => resolve(root, 'fixture', name);
const current = fixture('current.html');
const DEFAULT_STATE = resolve(root, '.scrape-heal', 'state.json');

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token?.startsWith('--')) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, 'true');
  }
}

const interval = Number(args.get('interval') ?? 10);
if (!Number.isFinite(interval) || interval <= 0) {
  console.error('--interval takes a positive number of seconds');
  process.exit(2);
}
const cycles = args.has('cycles') ? Number(args.get('cycles')) : undefined;
if (cycles !== undefined && (!Number.isFinite(cycles) || cycles <= 0)) {
  console.error('--cycles takes a positive number');
  process.exit(2);
}
const mutateEvery = args.has('mutate') ? Number(args.get('mutate')) : undefined;

const isDemo = args.has('demo');
const rowsFrom = args.get('rows-from');
const rowsFile = args.get('rows-file');
if (rowsFrom && rowsFile) {
  console.error('use --rows-from OR --rows-file, not both');
  process.exit(2);
}
if ((rowsFrom || rowsFile) && isDemo) {
  console.error('--demo serves the fixture itself; use --rows-from/--rows-file with a real target');
  process.exit(2);
}
if (isDemo && (args.has('url') || args.has('items'))) {
  console.error('--demo serves the fixture itself; do not combine it with --url/--items');
  process.exit(2);
}

// ---- demo fixture server ---------------------------------------------------
// Re-reads the file on every request, so swapping fixture/current.html (which
// --mutate does on a timer) changes the site under the watcher.
let server: ReturnType<typeof createServer> | null = null;
if (isDemo) {
  copyFileSync(fixture('site-v1.html'), current);
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current));
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
}

const port = server
  ? (server.address() as { port: number }).port
  : 0;

const config: ScraperConfig = isDemo
  ? {
      url: `http://127.0.0.1:${port}/`,
      items: '.product-card',
      fields: [
        { name: 'name', selector: '.name' },
        { name: 'price', selector: '.price' },
      ],
      identityField: 'name',
      minItems: 4,
    }
  : {
      url: args.get('url') ?? '',
      items: args.get('items') ?? '.product-card',
      fields: (args.get('fields') ?? 'name=.name,price=.price')
        .split(',')
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf('=');
          return eq === -1
            ? { name: pair, selector: pair }
            : { name: pair.slice(0, eq), selector: pair.slice(eq + 1) };
        }),
      identityField: args.get('identity') ?? 'name',
      minItems: Number(args.get('min') ?? 4),
    };

if (!config.url) {
  console.error('usage: --url <target> --items <sel> --fields name=.name,price=.price --min 4 --identity name  (or --demo)');
  process.exit(2);
}

// ---- mutate mode: the site redeploys once, after N seconds ----------------
// One flip keeps the demo readable: healthy → RED → REPAIRED → healthy again.
// A flip-flopping site would make the watcher look like it's thrashing when
// it's actually just tracking whichever markup is live.
if (mutateEvery !== undefined) {
  setTimeout(() => {
    copyFileSync(fixture('site-v2.html'), current);
    console.log('  [mutate] the site redeployed overnight — new markup is live');
  }, mutateEvery * 1000);
}

const fetchRows: RowFetch | undefined = rowsFrom
  ? commandRows(rowsFrom)
  : rowsFile
    ? fileRows(rowsFile)
    : undefined;

console.log(`  watching ${config.url || '(rows source)'} every ${interval}s${cycles ? ` for ${cycles} cycle(s)` : ''}${mutateEvery !== undefined ? `, site mutates every ${mutateEvery}s` : ''}${fetchRows ? ' (rows from an external scraper)' : ''}`);
console.log(`  state → ${args.get('state') ?? DEFAULT_STATE}`);
if (args.has('on-alert')) console.log('  alert hook armed: ' + args.get('on-alert'));
if (fetchRows && !config.url) console.log('  detection only — add --url to enable self-healing');
console.log('');

const browser = await chromium.launch();
const page = await browser.newPage();

const exitCode = await runWatchdog(browser, page, {
  intervalSeconds: interval,
  cycles,
  statePath: args.get('state') ?? DEFAULT_STATE,
  onAlert: args.get('on-alert'),
  fetchRows,
  writeConfigPath: args.get('write-config'),
  log: (line) => console.log(line),
}, config);

await browser.close();
server?.close();
process.exit(exitCode);
