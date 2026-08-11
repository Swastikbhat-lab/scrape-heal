/**
 * Evidence-on-red — what the page looked like when a cycle failed.
 *
 * A red alert used to be a one-line summary and a guess. Now every red cycle
 * keeps receipts: a full-page screenshot, the DOM snapshot, and the HTTP
 * status (when there was one). Evidence is written under the state directory
 * (`<stateDir>/evidence/<target>/…`), surfaced on the dashboard, and attached
 * to alerts, so "why is it red" has an answer that doesn't require trusting
 * the log.
 *
 * Evidence capture is strictly best-effort — a failed screenshot never takes
 * the loop down with it. Retention is capped per target (oldest evicted).
 */

import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Page } from 'playwright';

/** One captured red cycle. Paths are relative to the state directory, so the
 *  dashboard can serve them and alerts can reference them. */
export interface CycleEvidence {
  at: string;
  /** One line about why the cycle went red. */
  reason: string;
  /** HTTP status of the page response, when one was received. */
  status?: number;
  /** Full-page screenshot, e.g. "evidence/shop-a/2026-08-11T12-00-00_screenshot.png". */
  screenshot?: string;
  /** DOM snapshot, e.g. "evidence/shop-a/2026-08-11T12-00-00_dom.html". */
  dom?: string;
}

/** How many evidence sets are kept per target before the oldest are evicted. */
const KEEP = 5;

/** Monotonic suffix — two captures in the same millisecond must not collide. */
let seq = 0;
const stamp = (): string =>
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(seq++).padStart(3, '0')}`;

/** State-dir-relative path for a captured file, e.g.
 *  "evidence/shop-a/2026-08-11T12-00-00-000Z-000_screenshot.png". */
const stored = (targetKey: string, file: string): string =>
  join('evidence', targetKey, basename(file)).replace(/\\/g, '/');

/**
 * Screenshot the page and dump its DOM into the target's evidence dir.
 * Returns the evidence record (with paths relative to `stateDir`) — or a
 * reason-only record when the capture itself failed, so the caller always has
 * something to attach to the alert.
 */
export async function captureEvidence(
  page: Page,
  stateDir: string,
  targetKey: string,
  reason: string,
  status?: number,
): Promise<CycleEvidence> {
  const at = new Date().toISOString();
  const base: CycleEvidence = { at, reason, status };
  const dir = join(stateDir, 'evidence', targetKey);

  try {
    mkdirSync(dir, { recursive: true });
    const fileStamp = stamp();
    const screenshotPath = join(dir, `${fileStamp}_screenshot.png`);
    const domPath = join(dir, `${fileStamp}_dom.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    writeFileSync(domPath, html);

    prune(dir, KEEP);

    return {
      ...base,
      screenshot: stored(targetKey, screenshotPath),
      dom: stored(targetKey, domPath),
    };
  } catch {
    // Evidence is a nicety, never a failure mode.
    return base;
  }
}

/** Keep at most `keep` evidence sets (one set = a screenshot + a DOM file
 *  sharing a timestamp prefix); evict the oldest. Never throws. */
function prune(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir);
    const stamps = [
      ...new Set(
        files
          .filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{3}_.+\.(png|html)$/.test(f))
          .map((f) => f.split('_')[0]),
      ),
    ].sort();
    for (const stamp of stamps.slice(0, Math.max(0, stamps.length - keep))) {
      for (const f of files) {
        if (f.startsWith(stamp)) rmSync(join(dir, f), { force: true });
      }
    }
  } catch {
    // nothing to prune
  }
}
