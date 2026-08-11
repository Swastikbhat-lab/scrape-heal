import type { Page, Response } from 'playwright';
import { ProxyPool } from './proxy.js';
import type { ValueKind } from './valuetypes.js';

/**
 * One configurable field. Selectors are scoped *inside* each item container,
 * which is what lets the healer replace a single broken selector without
 * touching the rest of the config.
 */
export interface FieldConfig {
  name: string;
  selector: string;
  /**
   * Optional override of the field's value kind (price, percent, date, url,
   * image, number, slug, text). Normally derived automatically from the last
   * good run; set it when the baseline is ambiguous or the site's format is
   * about to change legitimately. The heal verify gate refuses a repair whose
   * values no longer look like this kind.
   */
  type?: ValueKind;
}

export interface ScraperConfig {
  url: string;
  /** Selector for the repeating item container (e.g. `.product-card`). */
  items: string;
  /** Field selectors, evaluated inside each item. */
  fields: FieldConfig[];
  /** Field that uniquely identifies an item (used to compare runs). */
  identityField: string;
  /** Minimum number of items the page is expected to yield. */
  minItems: number;
}

export interface ExtractedItem {
  [field: string]: string;
}

// ------------------------------------------------------------- failure classes

/** Why a fetch produced no rows, when the page itself never really loaded.
 *  These are the cases that must NEVER be healed — there is no broken
 *  selector, there is a broken fetch. */
export type FetchFailureKind = 'transient' | 'block';

export interface FetchFailure {
  /** 'transient' — the site was unreachable/overloaded (5xx, timeout, network
   *  error). Retry with backoff; if it persists, alert, never heal.
   *  'block' — the site refused us (403/429 or an anti-bot wall). Rotate
   *  proxies and retry; if it persists, alert, never heal. */
  kind: FetchFailureKind;
  message: string;
}

/** What one fetch of the page produced. */
export interface Extraction {
  /** The rows. [] means the page loaded but nothing matched the items
   *  selector — the first symptom of a redesign, and the healable case. */
  items: ExtractedItem[];
  /** HTTP status of the page response, when one was received. */
  status?: number;
  /** Set only when the page itself failed to load/respond. Never healed. */
  failed?: FetchFailure;
}

/** Classify an HTTP response: 5xx = transient, 403/429 or a block-page
 *  signature = blocked, anything else = fine (breakage is decided by shape,
 *  not by the response). Pure and unit-testable. */
export function classifyResponse(
  status: number | undefined,
  bodySample?: string,
): FetchFailureKind | undefined {
  if (status !== undefined && status >= 500) return 'transient';
  if (status === 403 || status === 429) return 'block';
  if (bodySample && ProxyPool.isBlocked(status ?? 200, bodySample)) return 'block';
  return undefined;
}

/**
 * Drive a real browser to the page and pull the configured fields out of
 * every item container.
 *
 * The return value classifies the failure so the loop can react correctly:
 * a 503 or a timeout is *transient* (retry, never heal), a 403/captcha wall
 * is a *block* (rotate proxies, never heal), and a page that loaded fine but
 * matched nothing is the plain empty list — that is the healable symptom.
 */
export async function extract(config: ScraperConfig, page: Page): Promise<Extraction> {
  let response: Response | null = null;
  try {
    response = await page.goto(config.url, { waitUntil: 'networkidle', timeout: 15_000 });
  } catch (err) {
    // Navigation failed — DNS, connection reset, timeout. Transient by
    // definition: retry with backoff, never heal.
    return { items: [], failed: { kind: 'transient', message: (err as Error).message } };
  }

  const status = response?.status();
  const kind = classifyResponse(status);
  if (kind === 'transient' || kind === 'block') {
    return { items: [], status, failed: { kind, message: `HTTP ${status}` } };
  }

  try {
    await page.waitForSelector(config.items, { timeout: 5_000 });
  } catch {
    // Nothing matched the items selector. Could be a redesign (breakage —
    // heal) or an anti-bot wall that answers 200. Read a body sample to
    // tell them apart before deciding.
    let bodySample = '';
    try {
      bodySample = ((await response?.text()) ?? '').slice(0, 4000);
    } catch { /* body unreadable — treat as plain breakage */ }
    const bodyKind = classifyResponse(status ?? 200, bodySample);
    if (bodyKind === 'block') {
      return {
        items: [],
        status,
        failed: { kind: 'block', message: 'block page detected (anti-bot challenge)' },
      };
    }
    return { items: [], status };
  }

  const count = await page.locator(config.items).count();
  const out: ExtractedItem[] = [];
  for (let i = 0; i < count; i++) {
    const row: ExtractedItem = {};
    for (const f of config.fields) {
      const loc = page.locator(config.items).nth(i).locator(f.selector);
      const n = await loc.count();
      row[f.name] = n > 0 ? ((await loc.first().textContent()) ?? '').trim() : '';
    }
    out.push(row);
  }
  return { items: out, status };
}

export interface Validation {
  ok: boolean;
  itemCount: number;
  issues: string[];
}

/**
 * A pluggable validator: receives the extracted rows plus the config and the
 * last good run, and decides whether they're good enough to trust. Replace the
 * built-in shape checks with the schema you already own (JSON Schema, a DTO
 * class, hand-written assertions) — the loop keeps the rest of its contract.
 */
export type Validator = (
  items: ExtractedItem[],
  ctx: { config: ScraperConfig; baseline: ExtractedItem[] },
) => Validation;

/**
 * The shape half of validation — enough items, no empty fields. The parts
 * that don't depend on the last good run. Used on its own when the baseline
 * itself is known to be stale (an LLM repair after the data changed).
 */
export function validateShape(config: ScraperConfig, items: ExtractedItem[]): Validation {
  const issues: string[] = [];

  if (items.length < config.minItems) {
    issues.push(`expected at least ${config.minItems} item(s), got ${items.length}`);
  }

  for (const f of config.fields) {
    const empties = items.filter((it) => !it[f.name]?.trim()).length;
    if (empties > 0) {
      issues.push(`field "${f.name}" is empty in ${empties} of ${items.length} item(s)`);
    }
  }

  return { ok: issues.length === 0, itemCount: items.length, issues };
}

/**
 * Is the extraction good enough to trust?
 *
 * When a pluggable validator is given, it replaces the built-in checks
 * entirely — your schema decides.
 *
 * Otherwise:
 *
 * - the page yielded at least `minItems`
 * - no required field came back empty
 * - every identity value from the last known-good run is still present
 *
 * The last check is the one that turns "the selector returned *something*"
 * into "the selector returned the *same data*". A scraper that returns the
 * wrong-but-shaped data is the failure nobody notices.
 */
export function validate(
  config: ScraperConfig,
  items: ExtractedItem[],
  baseline?: ExtractedItem[],
  validator?: Validator,
): Validation {
  if (validator) return validator(items, { config, baseline: baseline ?? [] });

  const shape = validateShape(config, items);
  if (!shape.ok) return shape;

  if (baseline?.length) {
    const id = config.identityField;
    const want = new Set(baseline.map((b) => b[id] ?? '').filter(Boolean));
    if (want.size) {
      const have = new Set(items.map((it) => it[id] ?? ''));
      const missing = [...want].filter((w) => !have.has(w));
      if (missing.length) {
        shape.issues.push(`missing known value(s): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`);
        shape.ok = false;
      }
    }
  }

  return shape;
}
