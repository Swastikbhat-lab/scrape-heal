/**
 * Change watching — diff every healthy cycle against the previous run.
 *
 * The loop already knows when extraction BREAKS. This is the other half:
 * when extraction succeeds but the DATA changed — a price dropped, an item
 * went out of stock, a new product appeared. The diff is structural: items
 * are matched by identity field, so the report says *which* product changed
 * and *how*, not "the page is different somewhere".
 *
 * Thresholds decide what's worth an alert (a 5% price drop, a restock, a
 * new listing). Everything is deterministic and unit-testable; the watchdog
 * just feeds it the previous and current rows.
 */

import type { ExtractedItem } from './scraper.js';

// ------------------------------------------------------------- report

export interface FieldChange {
  /** Identity value of the item that changed. */
  id: string;
  field: string;
  from: string;
  to: string;
  /** Set when both values parse as numbers (currency, counts, percentages). */
  numeric?: { from: number; to: number; delta: number; pct: number };
}

export interface ChangeReport {
  /** New identities — present now, absent in the previous run. */
  added: ExtractedItem[];
  /** Gone identities — present before, absent now. (With the built-in
   *  validator a removal usually makes the cycle RED instead; this category
   *  exists for custom validators and for the `removed` threshold.) */
  removed: ExtractedItem[];
  /** Per-field value changes, matched by identity. */
  changed: FieldChange[];
  count: { from: number; to: number };
}

// ------------------------------------------------------------- numbers

const NUMERIC_NOISE = /[$€£¥%,\s]/g;

/** Strip currency/grouping/percent noise and parse a number. Returns null
 *  when the value isn't numeric ("n/a", "out of stock", empty). */
export function parseNumber(value: string): number | null {
  const cleaned = value.replace(NUMERIC_NOISE, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

// ------------------------------------------------------------- diff

/**
 * Diff two extractions by identity. Deterministic output: added/removed in
 * document order, changed sorted by id then field.
 */
export function diffChanges(
  prev: ExtractedItem[],
  curr: ExtractedItem[],
  identityField: string,
): ChangeReport {
  const prevById = new Map<string, ExtractedItem>();
  for (const item of prev) {
    const id = (item[identityField] ?? '').trim();
    if (id) prevById.set(id, item);
  }
  const currById = new Map<string, ExtractedItem>();
  for (const item of curr) {
    const id = (item[identityField] ?? '').trim();
    if (id) currById.set(id, item);
  }

  const added = curr.filter((it) => {
    const id = (it[identityField] ?? '').trim();
    return !!id && !prevById.has(id);
  });

  const removed = prev.filter((it) => {
    const id = (it[identityField] ?? '').trim();
    return !!id && !currById.has(id);
  });

  const changed: FieldChange[] = [];
  for (const [id, before] of prevById) {
    const after = currById.get(id);
    if (!after) continue;
    for (const key of Object.keys(before)) {
      if (key === identityField) continue;
      const from = (before[key] ?? '').trim();
      const to = (after[key] ?? '').trim();
      if (from === to) continue;
      const nFrom = parseNumber(from);
      const nTo = parseNumber(to);
      const numeric = nFrom !== null && nTo !== null
        ? {
            from: nFrom,
            to: nTo,
            delta: nTo - nFrom,
            pct: nFrom !== 0 ? ((nTo - nFrom) / Math.abs(nFrom)) * 100 : 0,
          }
        : undefined;
      changed.push({ id, field: key, from, to, numeric });
    }
  }
  changed.sort((a, b) => a.id.localeCompare(b.id) || a.field.localeCompare(b.field));

  return { added, removed, changed, count: { from: prev.length, to: curr.length } };
}

/** A report worth logging — added, removed, or changed something. */
export function reportHasChanges(report: ChangeReport): boolean {
  return report.added.length > 0 || report.removed.length > 0 || report.changed.length > 0;
}

/** Human-readable lines, one per change, for the log and the dashboard. */
export function formatChanges(report: ChangeReport, identityField: string): string[] {
  const lines: string[] = [];
  if (report.added.length) {
    lines.push(`  + ${report.added.length} new: ${report.added.map((a) => a[identityField] ?? '?').join(', ')}`);
  }
  if (report.removed.length) {
    lines.push(`  − ${report.removed.length} gone: ${report.removed.map((r) => r[identityField] ?? '?').join(', ')}`);
  }
  for (const c of report.changed) {
    const num = c.numeric
      ? ` (${c.numeric.delta >= 0 ? '+' : ''}${fmt(c.numeric.delta)}, ${c.numeric.pct >= 0 ? '+' : ''}${fmt(c.numeric.pct)}%)`
      : '';
    lines.push(`  ~ ${c.id} · ${c.field}: "${c.from}" → "${c.to}"${num}`);
  }
  if (report.count.from !== report.count.to) {
    lines.push(`  · item count ${report.count.from} → ${report.count.to}`);
  }
  return lines;
}

// ------------------------------------------------------------- thresholds

/**
 * One alert rule. Conditions within a threshold are OR-ed — any of them
 * matching produces a hit. Examples:
 *
 *   { "field": "price", "dropPercent": 5 }         // price dropped ≥ 5%
 *   { "field": "stock", "changedTo": "in stock" }  // restocked
 *   { "field": "status", "changedFrom": "out of stock" }
 *   { "added": true }                              // any new item
 */
export interface ChangeThreshold {
  /** Field to watch. Omit when using `added`/`removed`. */
  field?: string;
  /** Numeric field dropped by at least this many percent. */
  dropPercent?: number;
  /** Numeric field rose by at least this many percent. */
  risePercent?: number;
  /** Field value became exactly this (trimmed). */
  changedTo?: string;
  /** Field value stopped being exactly this (trimmed). */
  changedFrom?: string;
  /** Any value change on the field. */
  anyChange?: boolean;
  /** Any new item. */
  added?: boolean;
  /** Any removed item. */
  removed?: boolean;
}

export interface ThresholdHit {
  /** Human rule, e.g. "price dropped ≥ 5%". */
  rule: string;
  /** The concrete changes that tripped it. */
  detail: string[];
}

/** Which thresholds trip on this report. One hit per matching threshold. */
export function matchesThresholds(
  report: ChangeReport,
  thresholds: ChangeThreshold[],
): ThresholdHit[] {
  const hits: ThresholdHit[] = [];
  for (const t of thresholds) {
    const detail: string[] = [];

    if (t.added && report.added.length) {
      detail.push(`${report.added.length} new item(s)`);
    }
    if (t.removed && report.removed.length) {
      detail.push(`${report.removed.length} item(s) gone`);
    }

    const changed = t.field
      ? report.changed.filter((c) => c.field === t.field)
      : report.changed;

    if (t.anyChange && changed.length) {
      detail.push(`${changed.length} value change(s) on "${t.field ?? 'any field'}"`);
    }
    if (typeof t.dropPercent === 'number') {
      for (const c of changed) {
        if (c.numeric && c.numeric.pct <= -Math.abs(t.dropPercent)) {
          detail.push(`${c.id} · ${c.field}: ${fmt(c.numeric.from)} → ${fmt(c.numeric.to)} (${fmt(c.numeric.pct)}%)`);
        }
      }
    }
    if (typeof t.risePercent === 'number') {
      for (const c of changed) {
        if (c.numeric && c.numeric.pct >= t.risePercent) {
          detail.push(`${c.id} · ${c.field}: ${fmt(c.numeric.from)} → ${fmt(c.numeric.to)} (+${fmt(c.numeric.pct)}%)`);
        }
      }
    }
    if (t.changedTo !== undefined) {
      for (const c of changed) {
        if (c.to === t.changedTo) {
          detail.push(`${c.id} · ${c.field}: "${c.from}" → "${c.to}"`);
        }
      }
    }
    if (t.changedFrom !== undefined) {
      for (const c of changed) {
        if (c.from === t.changedFrom) {
          detail.push(`${c.id} · ${c.field}: "${c.from}" → "${c.to}"`);
        }
      }
    }

    if (detail.length) {
      hits.push({ rule: describeThreshold(t), detail });
    }
  }
  return hits;
}

function describeThreshold(t: ChangeThreshold): string {
  const parts: string[] = [];
  if (t.added) parts.push('new item(s) appeared');
  if (t.removed) parts.push('item(s) removed');
  if (t.field) {
    if (typeof t.dropPercent === 'number') parts.push(`${t.field} dropped ≥ ${t.dropPercent}%`);
    if (typeof t.risePercent === 'number') parts.push(`${t.field} rose ≥ ${t.risePercent}%`);
    if (t.changedTo !== undefined) parts.push(`${t.field} became "${t.changedTo}"`);
    if (t.changedFrom !== undefined) parts.push(`${t.field} no longer "${t.changedFrom}"`);
    if (t.anyChange) parts.push(`${t.field} changed`);
  }
  return parts.join(', ') || 'change detected';
}
