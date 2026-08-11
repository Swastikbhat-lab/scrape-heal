import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FieldConfig, ScraperConfig } from './scraper.js';

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

  "_targets": "Optional: watch a fleet. Each entry is its own target; the top-level keys above are its defaults. Each target gets its own selectors, cadence, llm, validator, and state file. Delete the single-target keys above when using targets.",
  "targets": [
    {
      "url": "https://shop-a.example.com/products",
      "items": ".product-card",
      "fields": { "name": ".name", "price": ".price" },
      "intervalSeconds": 300,
      "llm": { "maxAttempts": 5 }
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
