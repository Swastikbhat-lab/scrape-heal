import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ScraperConfig } from './scraper.js';
import { runWatchdog } from './watchdog.js';
import { commandRows, fileRows, type RowFetch } from './source.js';
import {
  CONFIG_FILENAME, readConfigFile, fieldsFrom, initConfig, type WatchFileConfig,
} from './config.js';

/**
 * Watchdog mode: run the detect → heal → verify loop on a cadence.
 *
 * Plug-and-play is a config file, not flags:
 *
 *   npm run init                    # writes scraper.config.json template
 *   # ... fill in url/items/fields ...
 *   npm run watch                   # reads scraper.config.json automatically
 *
 * Flags override the file. Quick demos still work flag-free:
 *
 *   npm run watch -- --demo --mutate 12 --interval 5 --cycles 8
 *
 * A cycle that breaks AND cannot be verified-repaired exits non-zero, so a
 * scheduler (cron, CI) sees it.
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

// ---- --init: write a template config and stop ------------------------------
if (args.has('init')) {
  const path = args.get('init') === 'true' ? CONFIG_FILENAME : args.get('init')!;
  const wrote = initConfig(path, args.has('force'));
  if (wrote) {
    console.log(`wrote ${path} — fill in url/items/fields, then: npm run watch`);
  } else {
    console.error(`${path} already exists — use --force to overwrite`);
    process.exit(1);
  }
  process.exit(0);
}

// ---- load the file config ---------------------------------------------------
const filePath = args.get('config') ?? (existsSync(CONFIG_FILENAME) ? CONFIG_FILENAME : null);
let fileCfg: WatchFileConfig = {};
if (filePath) {
  try {
    fileCfg = readConfigFile(filePath);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

const isDemo = args.has('demo');
if (isDemo && args.has('config')) {
  console.error('--demo runs the fixture itself; do not combine it with --config');
  process.exit(2);
}

// ---- flags override the file ------------------------------------------------
const rowsFrom = args.get('rows-from') ?? fileCfg.rowsFrom;
const rowsFile = args.get('rows-file') ?? fileCfg.rowsFile;
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

const interval = Number(args.get('interval') ?? fileCfg.intervalSeconds ?? 10);
if (!Number.isFinite(interval) || interval <= 0) {
  console.error('interval must be a positive number of seconds (config key: intervalSeconds)');
  process.exit(2);
}
const cycles = args.has('cycles')
  ? Number(args.get('cycles'))
  : fileCfg.cycles ?? undefined;
if (cycles !== undefined && (!Number.isFinite(cycles) || cycles <= 0)) {
  console.error('--cycles takes a positive number');
  process.exit(2);
}
const mutateEvery = args.has('mutate') ? Number(args.get('mutate')) : undefined;

// ---- demo fixture server ----------------------------------------------------
let server: ReturnType<typeof createServer> | null = null;
if (isDemo) {
  copyFileSync(fixture('site-v1.html'), current);
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current));
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
}
const port = server ? (server.address() as { port: number }).port : 0;

// ---- the scraper config ------------------------------------------------------
const fields = fieldsFrom(fileCfg.fields, undefined) ?? (args.get('fields') ?? 'name=.name,price=.price')
  .split(',')
  .filter(Boolean)
  .map((pair) => {
    const eq = pair.indexOf('=');
    return eq === -1
      ? { name: pair, selector: pair }
      : { name: pair.slice(0, eq), selector: pair.slice(eq + 1) };
  });

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
      url: args.get('url') ?? fileCfg.url ?? '',
      items: args.get('items') ?? fileCfg.items ?? '.product-card',
      fields,
      identityField: args.get('identity') ?? fileCfg.identityField ?? 'name',
      minItems: Number(args.get('min') ?? fileCfg.minItems ?? 4),
    };

if (!config.url) {
  console.error(
    `no target — run \`npm run init\` to create ${CONFIG_FILENAME}, or pass --url <target> (or --demo)`,
  );
  process.exit(2);
}

// ---- mutate mode: the site redeploys once, after N seconds ------------------
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

const statePath = args.get('state') ?? fileCfg.statePath ?? DEFAULT_STATE;
const writeConfigPath = args.get('write-config') ?? fileCfg.writeConfig;
const onAlert = args.get('on-alert') ?? fileCfg.onAlert;

console.log(`  watching ${config.url || '(rows source)'} every ${interval}s${cycles ? ` for ${cycles} cycle(s)` : ''}${mutateEvery !== undefined ? `, site mutates every ${mutateEvery}s` : ''}${fetchRows ? ' (rows from an external scraper)' : ''}`);
if (filePath) console.log(`  config → ${filePath}`);
console.log(`  state → ${statePath}`);
if (onAlert) console.log('  alert hook armed');
if (fetchRows && !config.url) console.log('  detection only — set url to enable self-healing');
console.log('');

const browser = await chromium.launch();
const page = await browser.newPage();

const exitCode = await runWatchdog(browser, page, {
  intervalSeconds: interval,
  cycles,
  statePath,
  onAlert,
  fetchRows,
  writeConfigPath,
  log: (line) => console.log(line),
}, config);

await browser.close();
server?.close();
process.exit(exitCode);
