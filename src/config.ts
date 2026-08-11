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
  "statePath": ".scrape-heal/state.json"
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
