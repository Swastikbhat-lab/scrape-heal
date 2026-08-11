import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ScraperConfig, Validator } from './scraper.js';
import { runWatchdog } from './watchdog.js';
import { commandRows, fileRows, type RowFetch } from './source.js';
import { loadValidator } from './validator.js';
import type { LLMOptions } from './llm.js';
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
const mutateFlipEvery = args.has('mutate-flip') ? Number(args.get('mutate-flip')) : undefined;
const mutateValuesEvery = args.has('mutate-values') ? Number(args.get('mutate-values')) : undefined;
const mutateModes = [mutateEvery, mutateFlipEvery, mutateValuesEvery].filter((m) => m !== undefined).length;
if (mutateModes > 1) {
  console.error('use only one of --mutate, --mutate-flip, --mutate-values');
  process.exit(2);
}

// ---- demo fixture server ----------------------------------------------------
let server: ReturnType<typeof createServer> | null = null;
if (isDemo) {
  copyFileSync(fixture('site-v1.html'), current);
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current));
  });
  const listenPort = args.has('port') ? Number(args.get('port')) : 0;
  await new Promise<void>((ok) => server!.listen(listenPort, '127.0.0.1', ok));
}
const port = server ? (server.address() as { port: number }).port : 0;

// ---- mock LLM endpoint: serve a canned proposal so the LLM repair path can
// be demoed and tested without an API key. `@path` reads a JSON file. --------
const llmMock = args.get('llm-mock');
let llmServer: ReturnType<typeof createServer> | null = null;
if (llmMock) {
  const canned = llmMock.startsWith('@')
    ? readFileSync(fixture(llmMock.slice(1)), 'utf8')
    : llmMock;
  llmServer = createServer((req, res) => {
    req.on('data', () => {}); // drain — the reply is canned regardless
    req.on('end', () => {});
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: canned } }] }));
  });
  await new Promise<void>((ok) => llmServer!.listen(0, '127.0.0.1', ok));
}

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

// ---- values-change mode: the redesign also changed the data itself ---------
// This is the case text matching cannot handle — nothing on the page equals a
// known value. It exercises the LLM repair path (structure, not text).
if (mutateValuesEvery !== undefined) {
  setTimeout(() => {
    copyFileSync(fixture('site-v3.html'), current);
    console.log('  [mutate] the site redesigned AND the data changed — no known value survives');
  }, mutateValuesEvery * 1000);
}

// ---- flip mode: the site toggles between markup versions every N seconds ---
// The flip-flop is what the ledger exists for: after the first heal, a switch
// back to known markup is a LEDGER HIT, not a re-heal.
if (mutateFlipEvery !== undefined) {
  let version = 1;
  setInterval(() => {
    version = version === 1 ? 2 : 1;
    copyFileSync(fixture(`site-v${version}.html`), current);
    console.log(`  [flip] the site switched to the v${version} markup — A/B rollback`);
  }, mutateFlipEvery * 1000);
}

const fetchRows: RowFetch | undefined = rowsFrom
  ? commandRows(rowsFrom)
  : rowsFile
    ? fileRows(rowsFile)
    : undefined;

const statePath = args.get('state') ?? fileCfg.statePath ?? DEFAULT_STATE;
const writeConfigPath = args.get('write-config') ?? fileCfg.writeConfig;
const onAlert = args.get('on-alert') ?? fileCfg.onAlert;

// ---- LLM-assisted repair -----------------------------------------------------
const llmApiKey = args.get('llm-api-key') ?? fileCfg.llm?.apiKey ?? process.env.SCRAPE_HEAL_LLM_API_KEY;
const llmModel = args.get('llm-model') ?? fileCfg.llm?.model ?? process.env.SCRAPE_HEAL_LLM_MODEL;
const llmBaseUrlArg =
  args.get('llm-base-url') ?? fileCfg.llm?.baseUrl ?? process.env.SCRAPE_HEAL_LLM_BASE_URL;
const llmBaseUrl = llmMock
  ? `http://127.0.0.1:${(llmServer!.address() as { port: number }).port}/v1`
  : llmBaseUrlArg;
const llm: LLMOptions | undefined = llmMock || llmApiKey || llmBaseUrlArg || llmModel
  ? { apiKey: llmApiKey ?? (llmMock ? 'mock-key' : undefined), baseUrl: llmBaseUrl, model: llmModel }
  : undefined;

// ---- pluggable validator -----------------------------------------------------
const validatorPath = args.get('validator') ?? fileCfg.validator;
let validator: Validator | undefined;
if (validatorPath) {
  try {
    validator = await loadValidator(validatorPath);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

console.log(`  watching ${config.url || '(rows source)'} every ${interval}s${cycles ? ` for ${cycles} cycle(s)` : ''}${mutateEvery !== undefined ? `, site mutates every ${mutateEvery}s` : ''}${mutateFlipEvery !== undefined ? `, markup flips every ${mutateFlipEvery}s` : ''}${mutateValuesEvery !== undefined ? `, site + data change every ${mutateValuesEvery}s` : ''}${fetchRows ? ' (rows from an external scraper)' : ''}`);
if (filePath) console.log(`  config → ${filePath}`);
console.log(`  state → ${statePath}`);
if (onAlert) console.log('  alert hook armed');
if (llm) console.log(`  llm repair armed — model ${llm.model ?? 'gpt-4o-mini'}${llmMock ? ' (mock endpoint, no API key needed)' : ''}`);
if (validator) console.log(`  validator → ${validatorPath}`);
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
  llm,
  validator,
  log: (line) => console.log(line),
}, config);

await browser.close();
server?.close();
llmServer?.close();
process.exit(exitCode);
