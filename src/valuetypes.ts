/**
 * Value-type verification — the deepest layer of the heal verify gate.
 *
 * The shape gate proves a repair *extracted something*; the identity gate
 * proves it found the *same rows*. Neither can tell a correct binding from a
 * wrong one: after a redesign, a `price` selector that lands on *any* element
 * with text ("Free shipping") is non-empty, identities check out, and the
 * repair ships — silently corrupting the price column.
 *
 * This gate closes that hole. Every field's values in the last good run get a
 * *type profile* (the dominant kind — price, percent, date, URL, image,
 * number, code/SKU, or plain text — and how consistently it held). A repaired
 * extraction must still look like the same kind of data; if `price` suddenly
 * yields prose, the repair is refused and the loop keeps trying.
 *
 * Everything here is pure and regex-based — no LLM call, no network. It is
 * deliberately conservative (fail closed: a repair that might be wrong is
 * refused), and per-field `type` overrides or the global `verifyTypes` switch
 * exist for data that doesn't fit the taxonomy.
 */

/** What one value looks like, judged by shape alone. */
export type ValueKind =
  | 'price'   // $24.99, USD 12.99, 12,99 €
  | 'percent' // 20%, -5.00%
  | 'date'    // 2026-01-05, Jan 5, 2026, 01/05/2026
  | 'url'     // https://…
  | 'image'   // …/photo.png, data:image/…
  | 'number'  // 12.99, 1,234
  | 'slug'    // SKU-123, GTX-4090, tsla
  | 'text';   // everything else

/** Ordered most-specific → catch-all; the first match wins. */
const KIND_TESTS: [ValueKind, RegExp][] = [
  // Currency prefix or suffix (symbol, or USD/EUR word). Comes before number
  // so "$24.99" is a price, not a number.
  ['price', /^\s*(?:[$€£¥₹]|USD|EUR)\s*-?\d[\d,\.]*\s*$|^\s*-?\d[\d,\.]*\s*(?:[$€£¥₹]|USD|EUR)\s*$/i],
  ['percent', /^\s*-?\d+(?:[.,]\d+)?\s*%\s*$/],
  // ISO timestamps, "Jan 5, 2026", and MM/DD/YYYY. Must precede slug/number —
  // "2026-01-05" is slug-shaped and "01/05/2026" is text-shaped.
  ['date', /^\s*\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\s*$/],
  ['date', /^\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\s*$/i],
  ['date', /^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/],
  // Image before url: every image URL is also a URL. A URL whose path ends in
  // an image extension is an image; anything else http(s) is a URL.
  ['image', /^\s*(?:data:image\/[a-z+]+;base64,\S*|https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:\?[^\s]*)?)\s*$/i],
  ['url', /^\s*https?:\/\/\S+\s*$/i],
  ['number', /^\s*-?\d+(?:[.,]\d+)*\s*$/],
  ['slug', /^\s*[A-Za-z0-9][A-Za-z0-9._-]*\s*$/],
];

/** Classify one trimmed value by shape. Never throws — everything is text. */
export function classifyValue(value: string): ValueKind {
  const v = value.trim();
  if (!v) return 'text';
  for (const [kind, re] of KIND_TESTS) {
    if (re.test(v)) return kind;
  }
  return 'text';
}

/**
 * Two kinds are interchangeable when a redesign could plausibly change one
 * into the other without changing the data's meaning. Deliberately
 * asymmetric, because the failure costs differ:
 *
 * - price ↔ number — a site that drops its "$" sign must not fail the gate.
 * - text accepts slug — a *word-like* field (names, stock states) may
 *   legitimately flip between "in stock" (text) and "Available" (slug).
 * - slug does NOT accept text — a *code-like* field (SKU-123) turning into
 *   prose is exactly the wrong binding the gate exists to refuse.
 */
export function kindsCompatible(a: ValueKind, b: ValueKind): boolean {
  if (a === b) return true;
  if ((a === 'price' && b === 'number') || (a === 'number' && b === 'price')) return true;
  // a = the new value's kind, b = the field's kind: a *text* field may yield
  // single words ("Available"), but a *slug/code* field must not yield prose.
  return b === 'text' && a === 'slug';
}

/** A human label for an issue message. */
export function describeKind(kind: ValueKind): string {
  switch (kind) {
    case 'price': return 'a price';
    case 'percent': return 'a percentage';
    case 'date': return 'a date';
    case 'url': return 'a URL';
    case 'image': return 'an image URL';
    case 'number': return 'a number';
    case 'slug': return 'a code/SKU';
    case 'text': return 'plain text';
  }
}

/** The dominant value kind of a sample, plus how consistently it held. */
export interface ValueTypeProfile {
  kind: ValueKind;
  /** Fraction of non-empty values that were the dominant kind. 1 = uniform. */
  rate: number;
}

/** Profile a sample of values. Returns undefined when there is nothing to
 *  judge by (empty sample). */
export function profileField(values: string[]): ValueTypeProfile | undefined {
  const nonEmpty = values.map((v) => v.trim()).filter(Boolean);
  if (!nonEmpty.length) return undefined;
  const counts = new Map<ValueKind, number>();
  for (const v of nonEmpty) {
    const k = classifyValue(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: ValueKind = 'text';
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return { kind: best, rate: bestN / nonEmpty.length };
}

export interface TypedField {
  name: string;
  /** Optional override: force the field's kind instead of deriving it from
   *  the baseline. For data whose shape is ambiguous. */
  type?: ValueKind;
}

/**
 * The gate itself. Compares the *kind of data* a candidate extraction yields
 * against the kind the last good run yielded, per field. Returns a list of
 * issues; an empty list means the values still look like themselves.
 *
 * Tolerance: a repaired field must keep the dominant kind at least as
 * consistently as the baseline did (minus 0.15), and never below 0.5. A
 * forced `type` override demands a simple majority (0.6).
 *
 * Conservative by design — when a field's values change shape, the repair is
 * refused and the loop's cascade keeps trying. If the site genuinely changed
 * the data's format, that is what `fieldTypes` (or disabling the gate) is for.
 */
export function verifyValueTypes(
  fields: TypedField[],
  items: Record<string, string>[],
  baseline: Record<string, string>[],
): string[] {
  const issues: string[] = [];
  for (const f of fields) {
    const base = baseline.map((b) => (b[f.name] ?? '').trim()).filter(Boolean);
    if (!base.length) continue; // no profile to judge against
    const prof = profileField(base);
    if (!prof) continue;

    const kind = f.type ?? prof.kind;
    const newVals = items.map((it) => (it[f.name] ?? '').trim()).filter(Boolean);
    if (!newVals.length) continue; // the shape gate already rejects empties

    const matched = newVals.filter((v) => kindsCompatible(classifyValue(v), kind)).length;
    const got = matched / newVals.length;
    const need = f.type !== undefined ? 0.6 : Math.max(0.5, prof.rate - 0.15);
    if (got < need) {
      issues.push(
        `field "${f.name}" values no longer look like ${describeKind(kind)} ` +
          `(was ${Math.round(prof.rate * 100)}% ${describeKind(kind)}, now ${Math.round(got * 100)}%) — ` +
          'the selector may bind the wrong element; refusing the repair',
      );
    }
  }
  return issues;
}
