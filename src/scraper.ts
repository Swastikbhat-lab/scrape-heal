import type { Page } from 'playwright';

/**
 * One configurable field. Selectors are scoped *inside* each item container,
 * which is what lets the healer replace a single broken selector without
 * touching the rest of the config.
 */
export interface FieldConfig {
  name: string;
  selector: string;
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

/**
 * Drive a real browser to the page and pull the configured fields out of
 * every item container. Returns an empty list when the items selector itself
 * no longer matches anything — that is the first symptom of a redesign.
 */
export async function extract(config: ScraperConfig, page: Page): Promise<ExtractedItem[]> {
  await page.goto(config.url, { waitUntil: 'networkidle', timeout: 15_000 });

  try {
    await page.waitForSelector(config.items, { timeout: 5_000 });
  } catch {
    return [];
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
  return out;
}

export interface Validation {
  ok: boolean;
  itemCount: number;
  issues: string[];
}

/**
 * Is the extraction good enough to trust?
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
): Validation {
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

  if (baseline?.length) {
    const id = config.identityField;
    const want = new Set(baseline.map((b) => b[id] ?? '').filter(Boolean));
    if (want.size) {
      const have = new Set(items.map((it) => it[id] ?? ''));
      const missing = [...want].filter((w) => !have.has(w));
      if (missing.length) {
        issues.push(`missing known value(s): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`);
      }
    }
  }

  return { ok: issues.length === 0, itemCount: items.length, issues };
}
