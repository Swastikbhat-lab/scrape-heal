import type { Browser, BrowserContext } from 'playwright';
import type { ExtractedItem, ScraperConfig, Validator } from './scraper.js';
import { validate } from './scraper.js';
import { heal } from './heal.js';
import type { LLMOptions } from './llm.js';

/**
 * Drop-in self-healing for crawlers that already exist.
 *
 * Three wrappers around the same loop — extract → validate against the last
 * good run → when they stop matching, re-derive the selectors in a real
 * browser and prove the repair on the live page before returning:
 *
 * - `scrapeWithSelfHealing` — for plain Playwright scripts: give it your
 *   `extractRows`, it returns good rows + the fixed config.
 * - `withSelfHealing` — for Crawlee: wrap your per-request extraction with
 *   the returned guard; healthy requests pass through untouched.
 * - `repairSelectors` — the smallest piece: just repair, return the fixed
 *   config (or null).
 *
 * A failed repair never throws — it returns `repaired: false` with the
 * validation issues, so your crawler decides what to alert on.
 */

export interface SelfHealingOptions {
  /** The target config; selectors are repaired in place on breakage. */
  config: ScraperConfig;
  /** The last good run — the ground truth for repair. `[]` on first run. */
  lastGoodRows?: ExtractedItem[];
  /** Pluggable validator — replaces the built-in shape checks. */
  validator?: Validator;
  /** LLM-assisted repair for when even the values changed. */
  llm?: LLMOptions;
  /** Authenticated context (from `authenticate()`) — pages behind a login. */
  context?: BrowserContext;
  /** Called with the fixed config + verified rows after a verified repair. */
  onRepair?: (config: ScraperConfig, verified: ExtractedItem[]) => void | Promise<void>;
}

export interface SelfHealingResult {
  /** The rows to use: verified rows when repaired, the original ones otherwise. */
  rows: ExtractedItem[];
  /** The config to use: fixed when repaired, the original otherwise. */
  config: ScraperConfig;
  repaired: boolean;
  /** Why the original rows failed validation (set when not repaired). */
  issues?: string[];
  /** The full heal log (set when a repair was attempted). */
  attempts?: string[];
}

async function runGuard(
  browser: Browser,
  rows: ExtractedItem[],
  opts: SelfHealingOptions,
): Promise<SelfHealingResult> {
  const baseline = opts.lastGoodRows ?? [];
  const v = validate(opts.config, rows, baseline, opts.validator);
  if (v.ok) return { rows, config: opts.config, repaired: false };

  const result = await heal(browser, opts.config, baseline, {
    validator: opts.validator,
    llm: opts.llm,
    context: opts.context,
  });
  if (!result.repaired) {
    return {
      rows,
      config: opts.config,
      repaired: false,
      issues: v.issues,
      attempts: result.attempts,
    };
  }

  if (opts.onRepair) await opts.onRepair(result.config, result.verified ?? []);
  return { rows: result.verified ?? [], config: result.config, repaired: true };
}

/** For plain Playwright scripts: one guarded scrape that heals itself. */
export async function scrapeWithSelfHealing(
  opts: SelfHealingOptions & {
    browser: Browser;
    /** Your existing extraction — rows from the page, however you do it. */
    extractRows: () => Promise<ExtractedItem[]>;
  },
): Promise<SelfHealingResult> {
  const rows = await opts.extractRows();
  return runGuard(opts.browser, rows, opts);
}

/** For Crawlee: a per-request guard around your extraction. */
export function withSelfHealing(
  opts: SelfHealingOptions & {
    /** How the crawler gets its browser (e.g. its own launched instance). */
    getBrowser: () => Promise<Browser>;
  },
): (rows: ExtractedItem[]) => Promise<SelfHealingResult> {
  return async function guard(rows) {
    const browser = await opts.getBrowser();
    return runGuard(browser, rows, opts);
  };
}

/** The smallest piece: repair only, return the fixed config or null. */
export async function repairSelectors(
  browser: Browser,
  config: ScraperConfig,
  lastGoodRows: ExtractedItem[],
  opts: { validator?: Validator; llm?: LLMOptions; context?: BrowserContext } = {},
): Promise<ScraperConfig | null> {
  const result = await heal(browser, config, lastGoodRows, opts);
  return result.repaired ? result.config : null;
}
