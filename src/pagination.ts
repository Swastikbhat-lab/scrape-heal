/**
 * Multi-page scraping — pagination, "load more" buttons, infinite scroll.
 *
 * Most sites spread their data across pages. A scraper that only sees page 1
 * is extracting 10% of the catalog. This module handles the three common
 * pagination patterns:
 *
 *   1. **Link-based** — Next/Prev links or numbered page links.
 *      `config.pagination = { kind: 'next-link', selector: '.pagination .next' }`
 *
 *   2. **Load-more button** — A button that appends items via JS.
 *      `config.pagination = { kind: 'load-more', selector: 'button.load-more' }`
 *
 *   3. **Infinite scroll** — New items load when the user scrolls to the bottom.
 *      `config.pagination = { kind: 'infinite-scroll' }`
 *
 *   4. **URL pattern** — Page number in the URL.
 *      `config.pagination = { kind: 'url-pattern', pattern: '/products?page={page}' }`
 *
 * The module also handles:
 *   - Max pages/items caps so a scraper doesn't run forever
 *   - Duplicate detection (same item appearing on two pages)
 *   - Page transition wait conditions
 */

import type { Page } from 'playwright';
import type { ExtractedItem } from './scraper.js';

// ------------------------------------------------------------- pagination config

export type PaginationKind =
  | 'next-link'
  | 'load-more'
  | 'infinite-scroll'
  | 'url-pattern';

export interface PaginationConfig {
  /** The pagination strategy. */
  kind: PaginationKind;

  /** Selector for the Next link or Load More button (not used for infinite-scroll). */
  selector?: string;

  /** URL pattern for `url-pattern` kind. `{page}` is replaced with the page number. */
  pattern?: string;

  /** Maximum number of pages to traverse (safety cap). Default 20. */
  maxPages?: number;

  /** Maximum total items across all pages (safety cap). Default 500. */
  maxItems?: number;

  /** Milliseconds to wait after navigating to a new page. Default 1000. */
  pageWaitMs?: number;

  /** Field used to detect duplicates across pages (usually identityField). */
  dedupeField?: string;
}

export interface PagedResult {
  /** All items extracted across pages, deduped. */
  items: ExtractedItem[];
  /** How many pages were traversed. */
  pagesVisited: number;
  /** Per-page item counts, for diagnostics. */
  perPage: number[];
  /** Reason traversal stopped. */
  stopped: 'max-pages' | 'max-items' | 'no-next-page' | 'no-new-items' | 'error';
}

// ------------------------------------------------------------- traversal

/**
 * Walk every page, extracting items and deduping across pages. Returns the
 * union of all items seen.
 */
export async function extractAllPages(
  page: Page,
  baseUrl: string,
  extractOne: (page: Page) => Promise<ExtractedItem[]>,
  pagination: PaginationConfig,
): Promise<PagedResult> {
  const maxPages = pagination.maxPages ?? 20;
  const maxItems = pagination.maxItems ?? 500;
  const waitMs = pagination.pageWaitMs ?? 1000;
  const dedupeField = pagination.dedupeField;

  const allItems: ExtractedItem[] = [];
  const perPage: number[] = [];
  const seen = new Set<string>();
  let pagesVisited = 0;
  let stopped: PagedResult['stopped'] = 'no-next-page';

  // Navigate to the first page.
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 20_000 });

  for (let i = 0; i < maxPages; i++) {
    pagesVisited++;

    // Extract this page's items.
    let batch: ExtractedItem[];
    try {
      batch = await extractOne(page);
    } catch {
      stopped = 'error';
      break;
    }

    if (!batch.length) {
      stopped = 'no-next-page';
      break;
    }

    // Dedupe across pages.
    let newCount = 0;
    for (const item of batch) {
      const key = dedupeField ? item[dedupeField]?.trim() : JSON.stringify(item);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      allItems.push(item);
      newCount++;
    }

    perPage.push(batch.length);

    // Stop if we've collected enough.
    if (allItems.length >= maxItems) {
      stopped = 'max-items';
      break;
    }

    // If no new items arrived (all duplicates), the rest will be too.
    if (newCount === 0) {
      stopped = 'no-new-items';
      break;
    }

    // Try to go to the next page.
    const advanced = await advancePage(page, pagination, i + 2);
    if (!advanced) {
      stopped = 'no-next-page';
      break;
    }

    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (pagesVisited >= maxPages && stopped === 'no-next-page') {
    stopped = 'max-pages';
  }

  return { items: allItems, pagesVisited, perPage, stopped };
}

/**
 * Move to the next page using the configured strategy. Returns false when
 * there is no next page to go to.
 */
async function advancePage(
  page: Page,
  config: PaginationConfig,
  pageNum: number,
): Promise<boolean> {
  switch (config.kind) {
    case 'next-link': {
      if (!config.selector) return false;
      const next = page.locator(config.selector).first();
      if (!(await next.count()) || (await next.isDisabled?.().catch(() => false))) {
        return false;
      }
      await next.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return true;
    }

    case 'load-more': {
      if (!config.selector) return false;
      const btn = page.locator(config.selector).first();
      if (!(await btn.count())) return false;
      const wasVisible = await btn.isVisible().catch(() => false);
      if (!wasVisible) return false;
      await btn.click();
      // Wait for new content to appear — network idle is the simplest proxy.
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return true;
    }

    case 'infinite-scroll': {
      const prevHeight = await page.evaluate(() => document.body.scrollHeight) as number;
      // Scroll to the bottom in steps — a single jump can skip lazy-load triggers.
      for (let y = 0; y < prevHeight; y += 300) {
        await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
        await new Promise((r) => setTimeout(r, 100));
      }
      await page.waitForTimeout(1500); // let new content load
      const newHeight = await page.evaluate(() => document.body.scrollHeight) as number;
      return newHeight > prevHeight + 50; // something grew
    }

    case 'url-pattern': {
      if (!config.pattern) return false;
      const nextUrl = config.pattern.replace('{page}', String(pageNum));
      await page.goto(nextUrl, { waitUntil: 'networkidle', timeout: 20_000 });
      return true;
    }

    default:
      return false;
  }
}

// ------------------------------------------------------------- auto-detect

/**
 * Try to detect which pagination strategy the page uses.
 * Returns a config suggestion; the caller decides whether to trust it.
 */
export async function detectPagination(page: Page): Promise<PaginationConfig | null> {
  // Check for common Next link patterns.
  const nextSelectors = [
    'a[rel="next"]', '.pagination .next', '.pager .next',
    '[aria-label="Next"]', '[aria-label="Next page"]',
    'a:has-text("Next")', 'a:has-text("→")',
  ];

  for (const sel of nextSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible().catch(() => false)) {
        return { kind: 'next-link', selector: sel };
      }
    } catch { /* selector invalid — try the next one */ }
  }

  // Check for Load More button.
  const loadMoreSelectors = [
    'button:has-text("Load more")', 'button:has-text("Show more")',
    'a:has-text("Load more")', '[data-load-more]',
  ];

  for (const sel of loadMoreSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible().catch(() => false)) {
        return { kind: 'load-more', selector: sel };
      }
    } catch { /* selector invalid */ }
  }

  // Check for numbered page links (URL-pattern is likely).
  try {
    const pageLinks = await page.locator('.pagination a, .pager a').count();
    if (pageLinks >= 3) {
      // Try to extract the URL pattern from the first page link.
      const href = await page.locator('.pagination a, .pager a').first()
        .getAttribute('href').catch(() => null);
      if (href) {
        const pattern = href.replace(/[\d]+(?=\D*$)/, '{page}');
        return { kind: 'url-pattern', pattern };
      }
    }
  } catch { /* no pagination found */ }

  return null; // No pagination strategy detected.
}
