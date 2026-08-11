import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { ScraperConfig, ExtractedItem } from './scraper.js';
import { extract } from './scraper.js';

/**
 * The loop's contract with "whatever scraper you already have": produce rows.
 *
 * The rows are what detection validates against the last good run — the source
 * of them is irrelevant. Playwright is one source; a command that prints JSON
 * or CSV (Scrapy, Puppeteer, plain requests+regex, a cron dump) is another.
 *
 * The result distinguishes three failures, so the loop reacts correctly:
 *   - `items: null` — the source itself failed (crash, timeout, bad output).
 *     Reported as a source failure, never healed.
 *   - `failed.kind: 'transient'` — the site was unreachable/overloaded.
 *     Retried with backoff, never healed.
 *   - `failed.kind: 'block'` — the site refused us (403/captcha). Proxies are
 *     rotated, never healed.
 */
export type RowResult = {
  items: ExtractedItem[] | null;
  /** HTTP status of the page response, when one was received. */
  status?: number;
  /** Set only when the page itself failed to load/respond. Never healed. */
  failed?: { kind: 'transient' | 'block'; message: string };
};

export type RowFetch = () => Promise<RowResult>;

/** The built-in source: drive the page with Playwright and the config's selectors.
 *  Config is passed as a getter so that a repaired config takes effect on the
 *  very next extraction — snapshotting the object here would keep the loop
 *  re-detecting the same break forever. */
export const playwrightRows =
  (page: Page, getConfig: () => ScraperConfig): RowFetch =>
  () =>
    extract(getConfig(), page);

/** Run an external scraper and read its rows from stdout (JSON array or CSV). */
export const commandRows = (cmd: string): RowFetch => async () => {
  const out = await runCapture(cmd);
  if (!out.ok) return { items: null };
  try {
    return { items: parseRows(out.stdout) };
  } catch {
    return { items: null };
  }
};

/** Read rows from a JSON or CSV file. */
export const fileRows = (path: string): RowFetch => () => {
  try {
    return Promise.resolve({ items: parseRows(readFileSync(path, 'utf8')) });
  } catch {
    return Promise.resolve({ items: null });
  }
};

// ---------------------------------------------------------------- parsing

export function parseRows(text: string): ExtractedItem[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? (arr as ExtractedItem[]) : [];
  }

  // JSON Lines — one JSON object per line (Scrapy's stdout default).
  if (t.startsWith('{')) {
    const rows: ExtractedItem[] = [];
    for (const line of t.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') rows.push(obj as ExtractedItem);
    }
    return rows;
  }

  // CSV with a header row. Naive but sufficient: quoted fields, doubled
  // quotes, no embedded newlines.
  const lines = t.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCSV(lines[0]).map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cells = splitCSV(line);
    const row: ExtractedItem = {};
    header.forEach((h, i) => {
      if (h) row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

function splitCSV(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function runCapture(cmd: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, { shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      resolvePromise({ ok: false, stdout: `${err.message}\n${stderr}` });
    });
    child.on('close', (code) => {
      resolvePromise(code === 0 ? { ok: true, stdout } : { ok: false, stdout: stderr });
    });
  });
}
