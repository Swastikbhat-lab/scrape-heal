#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ScraperConfig, Validator } from './scraper.js';
import { runWatchdog } from './watchdog.js';
import { commandRows, fileRows, type RowFetch } from './source.js';
import { loadValidator } from './validator.js';
import type { AlertChannel } from './alert.js';
import { formatMemory } from './memory.js';
import type { ChangeThreshold } from './changes.js';
import { startDashboard } from './dashboard.js';
import type { LLMOptions, SiteLLMMemory } from './llm.js';
import {
  CONFIG_FILENAME, readConfigFile, fieldsFrom, initConfig, mergeTargetConfigs,
  type WatchFileConfig,
} from './config.js';
import type { AuthConfig } from './auth.js';
import { authenticate } from './auth.js';
import { heal } from './heal.js';
import type { ExtractedItem } from './scraper.js';

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

// ---- --memory [site]: show what the loop has learned about a site ----------
// Learned-rule visibility: the per-site LLM memory (verified repairs + failed
// proposals) lives in the state file. Print it for one site or for all.
if (args.has('memory')) {
  const site = args.get('memory') === 'true' ? undefined : args.get('memory');
  const memPath = args.get('state') ?? fileCfg.statePath ?? DEFAULT_STATE;
  let memory: Record<string, SiteLLMMemory> = {};
  if (existsSync(memPath)) {
    try {
      const parsed = JSON.parse(readFileSync(memPath, 'utf8')) as {
        llmMemory?: Record<string, SiteLLMMemory>;
      };
      memory = parsed.llmMemory ?? {};
    } catch {
      memory = {};
    }
  }
  console.log(formatMemory(memory, site));
  process.exit(0);
}

// ---- --repair: one-shot heal for an external scraper, write back, exit ----
// The drop-in seam for crawlers that can't host Node (Scrapy's middleware
// shells out to this) and for anyone who wants "fix it now" without a
// watchdog: give the loop the config and the last good rows, it re-measures
// the live page in a browser, heals, rewrites the config in place, and exits
// 0 on a verified repair / 1 when nothing could be shipped.
if (args.has('repair')) {
  if (!filePath) {
    console.error('repair needs a config: --config <scraper.config.json>');
    process.exit(2);
  }
  const spec = watchFrom(args, fileCfg, { armed: false }, 'repair');
  if (!spec.config.url) {
    console.error('repair needs a url — set it in the config file (or --url)');
    process.exit(2);
  }
  const baselineFile = args.get('rows') ?? args.get('rows-file') ?? fileCfg.rowsFile;
  const baselineCmd = args.get('rows-from') ?? fileCfg.rowsFrom;
  let baseline: ExtractedItem[] = [];
  if (baselineFile) baseline = (await fileRows(baselineFile)()).items ?? [];
  else if (baselineCmd) baseline = (await commandRows(baselineCmd)()).items ?? [];
  if (!baseline.length) {
    console.error(
      'repair needs the last good rows — --rows <file> (JSON/JSONL/CSV) or --rows-from "<cmd>" ' +
      'must produce parseable rows',
    );
    process.exit(2);
  }
  console.log(`  repairing ${spec.config.url} against ${baseline.length} baseline row(s)…`);
  const browser = await chromium.launch();
  let authHandle: Awaited<ReturnType<typeof authenticate>> | null = null;
  try {
    if (spec.auth) {
      authHandle = await authenticate(browser, spec.auth, (l) => console.log(`  ${l}`));
    }
    const result = await heal(browser, spec.config, baseline, {
      llm: spec.llm,
      validator: spec.validator,
      verifyTypes: spec.verifyValueTypes,
      context: authHandle?.context ?? undefined,
    });
    if (result.repaired && result.verified) {
      const out = args.get('write-config') ?? filePath;
      writeRepairedConfig(out, fileCfg, result.config);
      console.log(`  repaired — ${result.verified.length} item(s) verified on the live page`);
      console.log(`  new selectors written → ${out}`);
      for (const a of result.attempts) console.log(`  ${a}`);
      process.exit(0);
    }
    console.error('repair failed — nothing shipped, nothing modified:');
    for (const a of result.attempts) console.error(`  ${a}`);
    process.exit(1);
  } finally {
    if (authHandle) await authHandle.close();
    await browser.close();
  }
}

/**
 * Write a verified repair back into the watch config file, preserving every
 * other key (llm, alerts, targets, …) — only the selectors change. Fields are
 * written as the friendly object shape, so the file stays `scrape-heal`-readable.
 */
function writeRepairedConfig(out: string, original: WatchFileConfig, repaired: ScraperConfig): void {
  const fields: Record<string, string> = {};
  for (const f of repaired.fields) fields[f.name] = f.selector;
  const merged: WatchFileConfig = {
    ...original,
    items: repaired.items,
    fields,
    identityField: repaired.identityField,
    minItems: repaired.minItems,
  };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(merged, null, 2));
}

// ---- --dashboard: the live board over the per-target state files ----------
// The loop's state files ARE the data source — any number of watchdogs
// (single or fleet) show up here the moment they write. SSE + one page,
// zero dependencies.
if (args.has('dashboard')) {
  const stateDir =
    args.get('state-dir') ?? fileCfg.dashboard?.stateDir ?? dirname(DEFAULT_STATE);
  const portArg = args.get('dashboard');
  const port = portArg === 'true'
    ? fileCfg.dashboard?.port ?? 4321
    : Number(portArg);
  const dash = await startDashboard({
    stateDir,
    port: Number.isFinite(port) ? port : 4321,
    log: (line) => console.log(line),
  });
  console.log(`  state dir → ${stateDir}`);
  console.log('  Ctrl+C to stop');
  await new Promise(() => {}); // serve until interrupted
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
  alerts?: AlertChannel;
  validatorPath?: string;
  validator?: Validator;
  proxy?: { proxies?: string[]; providerUrl?: string };
  pagination?: { kind: string; selector?: string; pattern?: string; maxPages?: number };
  pipelines?: Record<string, unknown>[];
  auth?: AuthConfig;
  pluginsDir?: string;
  watch?: { enabled?: boolean; thresholds?: ChangeThreshold[] };
  verifyValueTypes?: boolean;
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

  const fields = fieldsFrom(cfg.fields, undefined, cfg.fieldTypes)
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

  // ---- v2: proxy, pagination, pipelines, auth, plugins -----------------
  const proxyFlag = args.get('proxy');
  const proxy = proxyFlag || cfg.proxy ? {
    proxies: proxyFlag ? proxyFlag.split(',').map(s => s.trim()).filter(Boolean) : cfg.proxy?.proxies,
    providerUrl: args.get('proxy-provider') ?? cfg.proxy?.providerUrl,
  } : undefined;

  const paginationFlag = args.get('pagination');
  const pagination = paginationFlag || cfg.pagination ? {
    kind: paginationFlag ?? cfg.pagination?.kind ?? 'next-link',
    selector: args.get('pagination-selector') ?? cfg.pagination?.selector,
    pattern: args.get('pagination-pattern') ?? cfg.pagination?.pattern,
    maxPages: Number(args.get('pagination-max') ?? cfg.pagination?.maxPages ?? 20),
  } : undefined;

  const pipelines = cfg.pipelines ?? undefined;

  const authFlag = args.get('auth');
  const auth: AuthConfig | undefined = authFlag || cfg.auth ? {
    kind: (authFlag ?? cfg.auth?.kind ?? 'none') as AuthConfig['kind'],
    cdp: args.get('auth-cdp') ?? cfg.auth?.cdp,
    dir: args.get('auth-dir') ?? cfg.auth?.dir,
    loginUrl: args.get('auth-login-url') ?? cfg.auth?.loginUrl,
    userSelector: args.get('auth-user-selector') ?? cfg.auth?.userSelector,
    passSelector: args.get('auth-pass-selector') ?? cfg.auth?.passSelector,
    submitSelector: args.get('auth-submit-selector') ?? cfg.auth?.submitSelector,
    sessionPath: args.get('auth-session') ?? cfg.auth?.sessionPath,
  } : undefined;

  const pluginsDir = args.get('plugins-dir') ?? cfg.pluginsDir;

  // v3: change watching — on by default; --no-watch turns it off; thresholds
  // come from the config file (a flag per threshold would be unreadable).
  const watch = {
    enabled: args.has('no-watch') ? false : cfg.watch?.enabled ?? true,
    thresholds: cfg.watch?.thresholds,
  };

  return {
    label, config, intervalSeconds: interval, cycles, statePath,
    writeConfigPath, onAlert, fetchRows, llm, alerts: cfg.alerts, validatorPath,
    proxy, pagination, pipelines, auth, pluginsDir, watch,
    verifyValueTypes: cfg.verifyValueTypes,
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
  // Plugins load into one shared registry (they are matched per URL, so
  // per-target plugin dirs coexist); the loop hooks them ahead of the
  // built-in extractor and healer.
  for (const s of specs) {
    if (s.pluginsDir) {
      try {
        const { loadPlugins } = await import('./plugins.js');
        const n = await loadPlugins(s.pluginsDir);
        if (n) console.log(`  [${s.label}] ${n} plugin(s) loaded from ${s.pluginsDir}`);
      } catch (err) {
        console.error(`  [${s.label}] plugins: ${(err as Error).message}`);
      }
    }
  }

  console.log(`  watching ${specs.length} target(s)…`);
  if (filePath) console.log(`  config → ${filePath}`);
  for (const s of specs) {
    console.log(
      `  [${s.label}] ${s.config.url} every ${s.intervalSeconds}s${s.cycles ? ` for ${s.cycles} cycle(s)` : ''}` +
      `${s.fetchRows ? ' (rows from an external scraper)' : ''}` +
      `${s.llm ? ` · llm repair (${s.llm.model ?? 'gpt-4o-mini'}, ${s.llm.maxAttempts ?? 3} attempt(s))` : ''}` +
      `${s.validator ? ' · custom validator' : ''}` +
      `${s.alerts ? ` · alerts: ${Object.keys(s.alerts).join(',')}` : ''}` +
      `${s.watch?.enabled !== false ? ` · change watching${s.alerts?.onChange ? ' (alerts on)' : ''}` : ''}`,
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
      alerts: s.alerts,
      proxy: s.proxy,
      pagination: s.pagination as any,
      pipelines: s.pipelines as any,
      watch: s.watch,
      verifyTypes: s.verifyValueTypes,
      auth: s.auth,
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

// ---- v2: load plugins --------------------------------------------------------
if (spec.pluginsDir) {
  try {
    const { loadPlugins } = await import('./plugins.js');
    const n = await loadPlugins(spec.pluginsDir);
    if (n) console.log(`  ${n} plugin(s) loaded from ${spec.pluginsDir}`);
  } catch (err) {
    console.error(`  plugins: ${(err as Error).message}`);
  }
}

console.log(`  watching ${spec.config.url || '(rows source)'} every ${spec.intervalSeconds}s${spec.cycles ? ` for ${spec.cycles} cycle(s)` : ''}${mutateEvery !== undefined ? `, site mutates every ${mutateEvery}s` : ''}${mutateFlipEvery !== undefined ? `, markup flips every ${mutateFlipEvery}s` : ''}${mutateValuesEvery !== undefined ? `, site + data change every ${mutateValuesEvery}s` : ''}${spec.fetchRows ? ' (rows from an external scraper)' : ''}`);
if (filePath) console.log(`  config → ${filePath}`);
console.log(`  state → ${spec.statePath}`);
if (spec.onAlert) console.log('  alert hook armed');
if (spec.llm) console.log(`  llm repair armed — model ${spec.llm.model ?? 'gpt-4o-mini'}, ${spec.llm.maxAttempts ?? 3} attempt(s)${llmMock ? ' (mock endpoint, no API key needed)' : ''}`);
if (spec.validator) console.log(`  validator → ${spec.validatorPath}`);
if (spec.alerts) console.log(`  alerts → ${Object.keys(spec.alerts).join(', ')}`);
if (spec.fetchRows && !spec.config.url) console.log('  detection only — set url to enable self-healing');
if (spec.proxy) console.log(`  proxy pool → ${spec.proxy.proxies?.length ?? 0} proxy(s)${spec.proxy.providerUrl ? ` + provider` : ''}`);
if (spec.pagination) console.log(`  pagination → ${spec.pagination.kind}${spec.pagination.selector ? ` (${spec.pagination.selector})` : ''}`);
if (spec.pipelines?.length) console.log(`  pipelines → ${spec.pipelines.length} output(s)`);
if (spec.auth && spec.auth.kind !== 'none') console.log(`  auth → ${spec.auth.kind}`);
if (spec.pluginsDir) console.log(`  plugins → ${spec.pluginsDir}`);
if (spec.watch?.enabled !== false) {
  console.log(`  change watching armed${spec.watch?.thresholds?.length ? ` — ${spec.watch.thresholds.length} threshold(s)` : ''}${spec.alerts?.onChange ? ' · alerts on change' : ''}`);
} else {
  console.log('  change watching disabled (--no-watch)');
}
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
  alerts: spec.alerts,
  proxy: spec.proxy,
  pagination: spec.pagination as any,
  pipelines: spec.pipelines as any,
  watch: spec.watch,
  verifyTypes: spec.verifyValueTypes,
  auth: spec.auth,
  log: (line) => console.log(line),
}, spec.config);

await browser.close();
server?.close();
llmServer?.close();
process.exit(exitCode);
