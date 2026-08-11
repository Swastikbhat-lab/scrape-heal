/**
 * Visual extraction — the fallback for when DOM selectors draw a blank.
 *
 * When a site redesign obliterates every class name AND changes the text
 * values, the last resort is to look at what the page actually renders.
 * This module captures a full-page screenshot, slices it into regions, and
 * uses OCR / layout analysis to reconstruct the data grid.
 *
 * Two modes:
 *   1. **OCR** (needs an external service or local engine) — extracts text
 *      from rendered pixels. Handles the case where the DOM is entirely
 *      generated (canvas, WebGL, WASM-rendered).
 *   2. **Layout analysis** (no OCR needed) — finds repeating visual patterns
 *      (same-height rows, aligned columns) and maps them back to DOM
 *      elements using hit-testing. Handles the case where the data IS in
 *      the DOM but the selectors are unrecognizable.
 *
 * The visual path is more expensive — a screenshot + OCR round-trip — so it
 * runs only when both the text healer and the LLM proposer have failed.
 */

import type { Page } from 'playwright';
import type { ExtractedItem, FieldConfig } from './scraper.js';

// ------------------------------------------------------------- layout analysis

export interface VisualGrid {
  /** Number of grid rows detected */
  rows: number;
  /** Number of grid columns detected */
  cols: number;
  /** Column headers guessed from the top row */
  headers: string[];
  /** Row bounding boxes, in page coordinates */
  rowBoxes: VisualBox[];
  /** Cell bounding boxes, as [row][col] */
  cells: VisualBox[][];
}

export interface VisualBox {
  x: number; y: number; width: number; height: number;
}

/**
 * Find repeating visual rows by looking for elements with identical heights
 * stacked vertically. A data grid is the most visually regular thing on any
 * listing page — same row height, same left edge, regular vertical spacing.
 *
 * Runs entirely in the browser (no external service), so it's free and
 * immediate. It cannot read the text inside the cells — that still needs
 * the DOM — but it can tell the healer *where* the grid is, which is half
 * the battle.
 */
const GRID_PROBE_CODE = `
  const all = [...document.querySelectorAll('body *')];
  const rects = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 8 || r.width > window.innerWidth * 0.95) continue;
    rects.push({
      el, tag: el.tagName.toLowerCase(),
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }

  // Group by y-coordinate (rows) — elements whose y overlaps are in the same row.
  const rows = [];
  const sorted = rects.sort((a, b) => a.y - b.y);
  for (const r of sorted) {
    const match = rows.find((row) => Math.abs(row[0].y - r.y) < 6);
    if (match) { match.push(r); continue; }
    rows.push([r]);
  }

  // Filter: a data row has at least 3 cells with similar heights.
  const candidates = rows
    .filter((row) => row.length >= 3)
    .map((row) => ({
      y: row[0].y, h: row[0].h,
      cols: row.sort((a, b) => a.x - b.x).length,
      cells: row.sort((a, b) => a.x - b.x).map((c) => ({ x: c.x, w: c.w })),
    }));

  // Find contiguous stretches of rows with the same column count.
  let best = { rows: 0, cols: 0, startY: 0, endY: 0 };
  let run = { rows: 1, cols: candidates[0]?.cols ?? 0, start: 0 };
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].cols === run.cols) { run.rows++; continue; }
    if (run.rows > best.rows) {
      best = { rows: run.rows, cols: run.cols,
        startY: candidates[run.start].y,
        endY: candidates[i - 1].y + candidates[i - 1].h };
    }
    run = { rows: 1, cols: candidates[i].cols, start: i };
  }
  if (run.rows > best.rows) {
    best = { rows: run.rows, cols: run.cols,
      startY: candidates[run.start].y,
      endY: candidates[candidates.length - 1].y + candidates[candidates.length - 1].h };
  }

  return best;
`;

export async function detectGrid(page: Page): Promise<VisualGrid | null> {
  const fn = new Function(GRID_PROBE_CODE) as () => {
    rows: number; cols: number; startY: number; endY: number;
  };
  const grid = await page.evaluate(fn);
  if (grid.rows < 2 || grid.cols < 2) return null;

  // Build cell boxes from the grid region.
  const rowH = (grid.endY - grid.startY) / grid.rows;
  const colW = page.viewportSize()?.width ?? 1280;
  const cells: VisualBox[][] = [];

  for (let r = 0; r < grid.rows; r++) {
    const row: VisualBox[] = [];
    for (let c = 0; c < grid.cols; c++) {
      row.push({
        x: Math.round((colW / grid.cols) * c),
        y: Math.round(grid.startY + rowH * r),
        width: Math.round(colW / grid.cols),
        height: Math.round(rowH),
      });
    }
    cells.push(row);
  }

  return {
    rows: grid.rows, cols: grid.cols,
    headers: [], // can't guess headers from layout alone
    rowBoxes: cells.map((row, i) => ({
      x: row[0].x, y: row[0].y,
      width: row.reduce((s, c) => s + c.width, 0),
      height: row[0].height,
    })),
    cells,
  };
}

/**
 * Map a visual grid back to DOM elements using elementFromPoint hit-testing.
 * For each cell in the detected grid, ask the browser what element sits at
 * its center point. The element's textContent is the cell value.
 *
 * This is the bridge from "I can see the grid" to "I know what's in it" —
 * no OCR required.
 */
const EXTRACT_BY_POINT_CODE = `
  const out = [];
  for (const cell of cells) {
    const cx = cell.x + cell.width / 2;
    const cy = cell.y + cell.height / 2;
    const el = document.elementFromPoint(cx, cy);
    out.push(el ? (el.textContent ?? '').trim() : '');
  }
  return out;
`;

export async function extractByGrid(
  page: Page,
  grid: VisualGrid,
  fields: FieldConfig[],
): Promise<ExtractedItem[]> {
  if (!grid.cells.length) return [];

  const fn = new Function('cells', EXTRACT_BY_POINT_CODE) as
    (cells: VisualBox[]) => string[];
  const texts = await page.evaluate(fn, grid.cells.flat());

  const items: ExtractedItem[] = [];
  for (let r = 0; r < grid.rows; r++) {
    const item: ExtractedItem = {};
    for (let c = 0; c < grid.cols && c < fields.length; c++) {
      const idx = r * grid.cols + c;
      item[fields[c].name] = texts[idx] ?? '';
    }
    items.push(item);
  }
  return items;
}

// ------------------------------------------------------------- OCR placeholder

/**
 * OCR-based extraction for Canvas/WebGL-rendered pages. This is a
 * placeholder: real OCR needs an external service (Tesseract WASM, Google
 * Vision, AWS Textract) and is wired in by the caller.
 *
 * The interface is deliberately narrow — a screenshot buffer in, text out —
 * so any OCR engine can be plugged in without changing the loop.
 */
export type OcrEngine = (screenshot: Buffer) => Promise<string>;

let _ocr: OcrEngine | null = null;

/** Register an OCR engine. Called once at startup. */
export function setOcrEngine(engine: OcrEngine): void {
  _ocr = engine;
}

/**
 * Take a screenshot and run OCR over it. Returns the full page text.
 * The caller must then parse the result into rows/fields — this is the raw
 * output and cannot guess your data model.
 */
export async function ocrPage(page: Page): Promise<string | null> {
  if (!_ocr) return null;
  const buf = await page.screenshot({ fullPage: true });
  return _ocr(buf);
}

/** Whether an OCR engine has been registered. */
export function ocrAvailable(): boolean {
  return _ocr !== null;
}
