import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FieldConfig, ScraperConfig } from './scraper.js';
import type { AlertChannel } from './alert.js';

/**
 * The on-disk watch config. Friendlier than the internal shape: fields is an
 * object (`"name": ".name"`) instead of an array, and every key is optional —
 * whatever is missing falls back to CLI flags, then to built-in defaults.
 */
export interface WatchFileConfig {
  url?: string;
  /** Selector for the repeating item container. */
  items?: string;
  /** Field name → selector, scoped inside each item. */
  fields?: Record<string, string>;
  /** Field that uniquely identifies an item. */
  identityField?: string;
  /** Minimum number of items the page is expected to yield. */
  minItems?: number;
  /** Seconds between watchdog cycles. */
  intervalSeconds?: number;
  /** Stop after this many cycles. Omit for continuous. */
  cycles?: number;
  /** Run this command each cycle and read rows (JSON or CSV) from its stdout. */
  rowsFrom?: string;
  /** Read rows from this file instead. */
  rowsFile?: string;
  /** Where verified repairs write the new selector config. */
  writeConfig?: string;
  /** Shell command run when a cycle goes red and cannot be repaired. */
  onAlert?: string;
  /** Where state (config + baseline) lives between runs. */
  statePath?: string;
  /** LLM-assisted repair, used when even the values changed (no text anchor
   *  survives). Any OpenAI-compatible endpoint works. Prefer the env vars for
   *  the key: SCRAPE_HEAL_LLM_API_KEY / _MODEL / _BASE_URL. */
  llm?: { apiKey?: string; model?: string; baseUrl?: string; maxAttempts?: number };
  /** Path to a JS file exporting a validator function that replaces the
   *  built-in shape checks. */
  validator?: string;
  /** Notify humans the day a target breaks: Slack / Discord / generic JSON
   *  webhook URLs. Per-target in a `targets` config. */
  alerts?: AlertChannel;
  /** Live dashboard server over the state directory. */
  dashboard?: { port?: number; stateDir?: string };
  /** v2: Proxy pool for anti-bot rotation. */
  proxy?: { proxies?: string[]; providerUrl?: string; providerRefreshSeconds?: number; cooldownBaseSeconds?: number; cooldownMaxSeconds?: number };
  /** v2: Multi-page pagination config. */
  pagination?: { kind: string; selector?: string; pattern?: string; maxPages?: number; maxItems?: number; pageWaitMs?: number; dedupeField?: string };
  /** v2: Data output pipelines (webhook, file, DB). */
  pipelines?: Record<string, unknown>[];
  /** v2: Authentication for pages behind a login. */
  auth?: { kind: string; cdp?: string; dir?: string; loginUrl?: string; userSelector?: string; passSelector?: string; submitSelector?: string; rememberSelector?: string; settleMs?: number; successSelector?: string; sessionPath?: string };
  /** v2: Directory of plugin files to load at startup. */
  pluginsDir?: string;
  /** Multiple targets: each entry is its own watch config, merged over the
   *  top-level keys as defaults. Each target gets its own selectors, cadence,
   *  LLM config, validator, and state file — a fleet of scrapers, one config. */
  targets?: WatchFileConfig[];
}

/**
 * Merge a per-target config over the global defaults. Target values win;
 * `llm` is deep-merged (a target can override just `maxAttempts`, say, and
 * inherit the global key/model). `targets` itself never inherits.
 */
export function mergeTargetConfigs(
  global: WatchFileConfig,
  target: WatchFileConfig,
): WatchFileConfig {
  const { targets: _gTargets, ...globals } = global;
  const { targets: _tTargets, ...t } = target;
  const merged: WatchFileConfig = { ...globals, ...t };
  if (global.llm || t.llm) {
    merged.llm = { ...(global.llm ?? {}), ...(t.llm ?? {}) };
  }
  if (global.alerts || t.alerts) {
    merged.alerts = { ...(global.alerts ?? {}), ...(t.alerts ?? {}) };
  }
  return merged;
}

export function readConfigFile(path: string): WatchFileConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read config ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config ${path} must be a JSON object`);
  }
  return parsed as WatchFileConfig;
}

export function fieldsFrom(
  obj: Record<string, string> | undefined,
  list: FieldConfig[] | undefined,
): FieldConfig[] | undefined {
  if (obj) return Object.entries(obj).map(([name, selector]) => ({ name, selector }));
  return list;
}

export const CONFIG_FILENAME = 'scraper.config.json';

export const TEMPLATE = `{
  "_note": "scrape-heal watch config. Every key is optional; CLI flags override. Delete the keys you don't need.",
  "url": "https://example.com/products",
  "items": ".product-card",
  "fields": {
    "name": ".name",
    "price": ".price"
  },
  "identityField": "name",
  "minItems": 4,

  "intervalSeconds": 300,
  "cycles": null,

  "_anyScraper": "The loop only needs your rows. Set rowsFrom to run any scraper that prints JSON/CSV; the browser is used only to find and verify repairs.",
  "rowsFrom": null,
  "rowsFile": null,

  "_repairs": "On a verified repair the new selectors are written here — point your scraper at this file.",
  "writeConfig": "scraper.config.json",

  "_alert": "Command run the moment a cycle goes red and cannot be repaired. The summary arrives in $SCRAPE_HEAL_ALERT.",
  "onAlert": null,
  "statePath": ".scrape-heal/state.json",

  "_llm": "Optional repair mode for when even the VALUES changed (no text to anchor on). Any OpenAI-compatible endpoint. Key via env: SCRAPE_HEAL_LLM_API_KEY. maxAttempts = the repair budget (propose→verify tries before giving up).",
  "llm": { "apiKey": null, "model": "gpt-4o-mini", "baseUrl": null, "maxAttempts": 3 },

  "_validator": "Optional: path to a JS file exporting a function (items, {config, baseline}) => {ok, itemCount, issues} that replaces the built-in shape checks.",
  "validator": null,

  "_alerts": "Optional: notify humans the day a cycle breaks. Incoming-webhook URLs — Slack, Discord, or any generic JSON webhook. cooldownMinutes throttles to one alert per target per N minutes (default 60); 0 = alert every red cycle.",
  "alerts": { "slack": null, "discord": null, "webhook": null, "cooldownMinutes": 60 },

  "_proxy": "v2 Optional: rotate proxies to avoid anti-bot blocks. Static list or a provider URL that returns a JSON array of proxy URLs. cooldownBaseSeconds: base cooldown on block (default 30, doubles per consecutive failure, max 300).",
  "proxy": { "proxies": null, "providerUrl": null, "providerRefreshSeconds": 120, "cooldownBaseSeconds": 30, "cooldownMaxSeconds": 300 },

  "_pagination": "v2 Optional: walk every page, not just the first. next-link clicks a selector; load-more clicks a button; infinite-scroll scrolls; url-pattern substitutes {page}. maxPages caps the walk (default 20).",
  "pagination": { "kind": "next-link", "selector": ".pagination .next", "maxPages": 20, "maxItems": 500 },

  "_pipelines": "v2 Optional: where extracted data goes after a healthy cycle. webhook posts one or all rows; file writes JSON/JSONL; postgres/mysql need registerDbRunner().",
  "pipelines": [
    { "kind": "webhook", "url": null, "secret": null },
    { "kind": "file", "path": "./data/products.jsonl" }
  ],

  "_auth": "v2 Optional: scrape pages behind a login. attach connects to your signed-in browser via CDP; profile uses a persistent browser context (sign in once, scrape forever); login fills a form (credentials from SCRAPE_HEAL_AUTH_USER/PASS env vars — never stored in config).",
  "auth": { "kind": "attach", "cdp": "http://127.0.0.1:9222" },

  "_plugins": "v2 Optional: directory of plugin files (extractors, healers, transforms) loaded at startup. Each file exports a plugin object. Plugins are tried in registration order before the built-in logic.",
  "pluginsDir": "./scrape-heal-plugins",

  "_dashboard": "Optional: a live board of every target's last cycle, heal history, and learned rules. npm run dashboard (or scrape-heal --dashboard [port]) starts it; stateDir is where the per-target state files live.",
  "dashboard": { "port": 4321, "stateDir": ".scrape-heal" },

  "_targets": "Optional: watch a fleet. Each entry is its own target; the top-level keys above are its defaults. Each target gets its own selectors, cadence, llm, validator, proxy, pagination, pipelines, and state file. Delete the single-target keys above when using targets.",
  "targets": [
    {
      "url": "https://shop-a.example.com/products",
      "items": ".product-card",
      "fields": { "name": ".name", "price": ".price" },
      "intervalSeconds": 300,
      "llm": { "maxAttempts": 5 },
      "pagination": { "kind": "next-link", "selector": ".pagination .next" }
    },
    {
      "url": "https://shop-b.example.com/items",
      "rowsFrom": null,
      "validator": "validator-b.js",
      "intervalSeconds": 600
    }
  ]
}
`;

/**
 * Write a template config. Returns true when written; false when the file
 * already exists and force was not requested.
 */
export function initConfig(path: string, force: boolean): boolean {
  if (!force && existsSync(path)) return false;
  writeFileSync(path, TEMPLATE);
  return true;
}
