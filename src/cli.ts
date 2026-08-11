#!/usr/bin/env node

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
  CONFIG_FILENAME, readConfigFile, fieldsFrom, initConfig, mergeTargetConfigs,
  type WatchFileConfig,
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
 * A fleet is one config file too — the top-level keys are the defaults, and
 * `targets` lists the sites, each with its own selectors, cadence, llm,
 * validator, and state file. A cycle that breaks AND cannot be
 * verified-repaired exits non-zero, so a scheduler (cron, CI) sees it.
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

const mutateEvery = args.has('mutate') ? Number(args.get('mutate')) : undefined;
const mutateFlipEvery = args.has('mutate-flip') ? Number(args.get('mutate-flip')) : undefined;
const mutateValuesEvery = args.has('mutate-values') ? Number(args.get('mutate-values')) : undefined;
const mutateModes = [mutateEvery, mutateFlipEvery, mutateValuesEvery].filter((m) => m !== undefined).length;
if (mutateModes > 1) {
  console.error('use only one of --mutate, --mutate-flip, --mutate-values');
  process.exit(2);
}

// ------------------------------------------------------------- watch spec ----

interface WatchSpec {
  label: string;
  config: ScraperConfig;
  intervalSeconds: number;
  cycles?: number;
  statePath: string;
  writeConfigPath?: string;
  onAlert?: string;
  fetchRows?: RowFetch;
  llm?: LLMOptions;
  validatorPath?: string;
  validator?: Validator;
}

function parseFieldsFlag(s: string): { name: string; selector: string }[] {
  return s.split(',')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1
        ? { name: pair, selector: pair }
        : { name: pair.slice(0, eq), selector: pair.slice(eq + 1) };
    });
}

/**
 * Everything one watchdog run needs, from one merged config. Flags override
 * the file, the file overrides defaults. `mock` is the keyless demo path: the
 * LLM endpoint is a local stub serving a canned proposal.
 */
function watchFrom(
  args: Map<string, string>,
  cfg: WatchFileConfig,
  mock: { armed: boolean; baseUrl?: string },
  label: string,
): WatchSpec {
  const rowsFrom = args.get('rows-from') ?? cfg.rowsFrom;
  const rowsFile = args.get('rows-file') ?? cfg.rowsFile;
  if (rowsFrom && rowsFile) {
    console.error('use --rows-from OR --rows-file, not both');
    process.exit(2);
  }

  const interval = Number(args.get('interval') ?? cfg.intervalSeconds ?? 10);
  if (!Number.isFinite(interval) || interval <= 0) {
    console.error('interval must be a positive number of seconds (config key: intervalSeconds)');
    process.exit(2);
  }
  const cycles = args.has('cycles')
    ? Number(args.get('cycles'))
    : cfg.cycles ?? undefined;
  if (cycles !== undefined && (!Number.isFinite(cycles) || cycles <= 0)) {
    console.error('--cycles takes a positive number');
    process.exit(2);
  }

  const fields = fieldsFrom(cfg.fields, undefined)
    ?? parseFieldsFlag(args.get('fields') ?? 'name=.name,price=.price');
  const config: ScraperConfig = {
    url: args.get('url') ?? cfg.url ?? '',
    items: args.get('items') ?? cfg.items ?? '.product-card',
    fields,
    identityField: args.get('identity') ?? cfg.identityField ?? 'name',
    minItems: Number(args.get('min') ?? cfg.minItems ?? 4),
  };
  const fetchRows: RowFetch | undefined = rowsFrom
    ? commandRows(rowsFrom)
    : rowsFile
      ? fileRows(rowsFile)
      : undefined;

  const statePath = args.get('state') ?? cfg.statePath ?? DEFAULT_STATE;
  const writeConfigPath = args.get('write-config') ?? cfg.writeConfig;
  const onAlert = args.get('on-alert') ?? cfg.onAlert;

  const llmMock = args.get('llm-mock');
  const llmApiKey = args.get('llm-api-key') ?? cfg.llm?.apiKey ?? process.env.SCRAPE_HEAL_LLM_API_KEY;
  const llmModel = args.get('llm-model') ?? cfg.llm?.model ?? process.env.SCRAPE_HEAL_LLM_MODEL;
  const llmBaseUrlArg =
    args.get('llm-base-url') ?? cfg.llm?.baseUrl ?? process.env.SCRAPE_HEAL_LLM_BASE_URL;
  const llm: LLMOptions | undefined = llmMock || llmApiKey || llmBaseUrlArg || llmModel
    ? {
        apiKey: llmApiKey ?? (mock.armed ? 'mock-key' : undefined),
        baseUrl: mock.armed ? mock.baseUrl : llmBaseUrlArg,
        model: llmModel,
        maxAttempts: cfg.llm?.maxAttempts,
      }
    : undefined;

  const validatorPath = args.get('validator') ?? cfg.validator;
  return {
    label, config, intervalSeconds: interval, cycles, statePath,
    writeConfigPath, onAlert, fetchRows, llm, validatorPath,
  };
}

async function loadValidatorOpt(path: string | undefined): Promise<Validator | undefined> {
  if (!path) return undefined;
  try {
    return await loadValidator(path);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

function hostLabel(url: string): string {
  try {
    // host, not hostname — includes the port, so two targets on the same
    // machine (different ports) get distinct labels and state files.
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// ------------------------------------------------------------ targets mode --
// A fleet is one config file: top-level keys are defaults, `targets` lists the
// sites. Each target runs its own concurrent watchdog with its own selectors,
// cadence, llm/validator, and state file.
const targets = fileCfg.targets ?? [];
if (targets.length > 0) {
  if (isDemo) {
    console.error('--demo cannot be combined with "targets" — configure each target in the config file');
    process.exit(2);
  }
  const forbidden = [
    'url', 'items', 'fields', 'identity', 'min',
    'rows-from', 'rows-file', 'mutate', 'mutate-flip', 'mutate-values',
    'port', 'llm-mock', 'state',
  ];
  const clash = forbidden.filter((k) => args.has(k));
  if (clash.length) {
    console.error(
      `single-target flags cannot be combined with "targets": --${clash.join(', --')} — set per-target options in the config file`,
    );
    process.exit(2);
  }

  const specs: WatchSpec[] = targets.map((t, i) => {
    const merged = mergeTargetConfigs(fileCfg, t);
    const label = merged.url
      ? hostLabel(merged.url)
      : merged.rowsFrom
        ? `rows-${i + 1}`
        : `target-${i + 1}`;
    // Each target gets its own state file by default — a shared one would
    // have the watchdogs clobber each other.
    if (!merged.statePath) {
      merged.statePath = resolve(dirname(DEFAULT_STATE), `${label}.json`);
    }
    return watchFrom(args, merged, { armed: false }, label);
  });
  for (const s of specs) {
    if (!s.config.url) {
      console.error(`target "${s.label}": no url — set url (or rowsFrom/rowsFile) for every target`);
      process.exit(2);
    }
  }
  for (const s of specs) {
    s.validator = await loadValidatorOpt(s.validatorPath);
  }

  console.log(`  watching ${specs.length} target(s)…`);
  if (filePath) console.log(`  config → ${filePath}`);
  for (const s of specs) {
    console.log(
      `  [${s.label}] ${s.config.url} every ${s.intervalSeconds}s${s.cycles ? ` for ${s.cycles} cycle(s)` : ''}` +
      `${s.fetchRows ? ' (rows from an external scraper)' : ''}` +
      `${s.llm ? ` · llm repair (${s.llm.model ?? 'gpt-4o-mini'}, ${s.llm.maxAttempts ?? 3} attempt(s))` : ''}` +
      `${s.validator ? ' · custom validator' : ''}`,
    );
  }
  console.log('');

  const browser = await chromium.launch();
  const results = await Promise.all(specs.map(async (s) => {
    const page = await browser.newPage();
    return runWatchdog(browser, page, {
      intervalSeconds: s.intervalSeconds,
      cycles: s.cycles,
      statePath: s.statePath,
      onAlert: s.onAlert,
      fetchRows: s.fetchRows,
      writeConfigPath: s.writeConfigPath,
      llm: s.llm,
      validator: s.validator,
      log: (line) => console.log(`[${s.label}] ${line}`),
    }, s.config);
  }));
  await browser.close();
  process.exit(results.some((c) => c === 1) ? 1 : 0);
}

// ---------------------------------------------------------- single target ----
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
let mockBaseUrl: string | undefined;
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
  mockBaseUrl = `http://127.0.0.1:${(llmServer.address() as { port: number }).port}/v1`;
}

// ---- the watch spec ----------------------------------------------------------
const spec = watchFrom(args, fileCfg, { armed: !!llmMock, baseUrl: mockBaseUrl }, '');
if (isDemo) {
  spec.config = {
    url: `http://127.0.0.1:${port}/`,
    items: '.product-card',
    fields: [
      { name: 'name', selector: '.name' },
      { name: 'price', selector: '.price' },
    ],
    identityField: 'name',
    minItems: 4,
  };
}
if (!spec.config.url) {
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

// ---- pluggable validator -----------------------------------------------------
spec.validator = await loadValidatorOpt(spec.validatorPath);

console.log(`  watching ${spec.config.url || '(rows source)'} every ${spec.intervalSeconds}s${spec.cycles ? ` for ${spec.cycles} cycle(s)` : ''}${mutateEvery !== undefined ? `, site mutates every ${mutateEvery}s` : ''}${mutateFlipEvery !== undefined ? `, markup flips every ${mutateFlipEvery}s` : ''}${mutateValuesEvery !== undefined ? `, site + data change every ${mutateValuesEvery}s` : ''}${spec.fetchRows ? ' (rows from an external scraper)' : ''}`);
if (filePath) console.log(`  config → ${filePath}`);
console.log(`  state → ${spec.statePath}`);
if (spec.onAlert) console.log('  alert hook armed');
if (spec.llm) console.log(`  llm repair armed — model ${spec.llm.model ?? 'gpt-4o-mini'}, ${spec.llm.maxAttempts ?? 3} attempt(s)${llmMock ? ' (mock endpoint, no API key needed)' : ''}`);
if (spec.validator) console.log(`  validator → ${spec.validatorPath}`);
if (spec.fetchRows && !spec.config.url) console.log('  detection only — set url to enable self-healing');
console.log('');

const browser = await chromium.launch();
const page = await browser.newPage();

const exitCode = await runWatchdog(browser, page, {
  intervalSeconds: spec.intervalSeconds,
  cycles: spec.cycles,
  statePath: spec.statePath,
  onAlert: spec.onAlert,
  fetchRows: spec.fetchRows,
  writeConfigPath: spec.writeConfigPath,
  llm: spec.llm,
  validator: spec.validator,
  log: (line) => console.log(line),
}, spec.config);

await browser.close();
server?.close();
llmServer?.close();
process.exit(exitCode);
