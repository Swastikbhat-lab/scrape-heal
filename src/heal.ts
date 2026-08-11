import type { Browser, Page } from 'playwright';
import type { ScraperConfig, ExtractedItem, FieldConfig } from './scraper.js';
import { extract, validate } from './scraper.js';

export interface HealResult {
  repaired: boolean;
  /** A human-readable log of everything the loop tried and decided. */
  attempts: string[];
  /** The repaired config, or the original when nothing passed. */
  config: ScraperConfig;
  /** What the repaired config extracted, verified against the live page. */
  verified: ExtractedItem[] | null;
}

interface Match {
  tag: string;
  cls: string[];
  ancTag: string;
  ancCls: string[];
}

/**
 * Find elements whose own text equals one of the known-good values.
 *
 * The leaf rule is what stops `body` (whose textContent contains everything)
 * from matching: an element only counts if none of its children carry text of
 * their own. Each match also records the nearest classed ancestor, which is
 * how the item container gets rediscovered after a redesign.
 *
 * The function is built with `new Function` on purpose: bundlers annotate
 * ordinary functions with helpers (e.g. esbuild's `__name`) that are invisible
 * inside a Playwright `page.evaluate` context, and a missing helper throws in
 * the browser. A Function built from a string serialises verbatim.
 */
const MATCH_BY_TEXT_CODE = `
  const isClass = (c) => /^[a-zA-Z_][\\w-]*$/.test(c);
  const want = new Set(values);
  const all = [...document.querySelectorAll('body *')];
  const out = [];
  for (const el of all) {
    const text = (el.textContent ?? '').trim();
    if (!want.has(text)) continue;
    let hasTextChild = false;
    for (const c of el.children) {
      if ((c.textContent ?? '').trim()) { hasTextChild = true; break; }
    }
    if (hasTextChild) continue;
    const cls = [...el.classList].filter((c) => isClass(c));
    let a = el.parentElement;
    let ancTag = '';
    let ancCls = [];
    while (a && a !== document.body) {
      const ac = [...a.classList].filter((c) => isClass(c));
      if (ac.length) { ancTag = a.tagName.toLowerCase(); ancCls = ac; break; }
      a = a.parentElement;
    }
    out.push({ tag: el.tagName.toLowerCase(), cls, ancTag, ancCls });
  }
  return out;
`;

async function matchByText(page: Page, known: string[]): Promise<Match[]> {
  const fn = new Function('values', MATCH_BY_TEXT_CODE) as (values: string[]) => Match[];
  return page.evaluate(fn, [...new Set(known)]);
}

const sel = (m: Pick<Match, 'tag' | 'cls'>): string =>
  m.cls.length ? `${m.tag}.${m.cls.join('.')}` : m.tag;

/**
 * Repair a broken config.
 *
 * The trick that makes this safe: the *last good run* is the ground truth.
 * We know the items existed and we know what their fields contained, so the
 * healer looks for elements that still contain those exact values and derives
 * new selectors from them. Then — the load-bearing step — the candidate config
 * is re-run against the live page and only shipped if the schema validates
 * AND every known identity is still there. No verification, no repair.
 */
export async function heal(
  browser: Browser,
  config: ScraperConfig,
  baseline: ExtractedItem[],
): Promise<HealResult> {
  const attempts: string[] = [];
  const id = config.identityField;
  const known = [...new Set(baseline.map((b) => (b[id] ?? '').trim()).filter(Boolean))];

  const page: Page = await browser.newPage();
  try {
    await page.goto(config.url, { waitUntil: 'networkidle', timeout: 15_000 });

    // The first pass is over identity values only: if nothing on the page
    // still contains a single known identity, no repair can be derived.
    const identityMatches = await matchByText(page, known);
    if (!identityMatches.length) {
      attempts.push(
        `heal: no element on the page still contains any known "${id}" value — ` +
        'the redesign may have changed the data itself. Nothing to anchor a repair to.',
      );
      return { repaired: false, attempts, config, verified: null };
    }

    // ---- rediscover the item container -----------------------------------
    // The nearest classed ancestor of an identity element that appears at
    // least `minItems` times on the page is the new container.
    const itemCandidates = [
      ...new Set(identityMatches.map((m) => `.${m.ancCls.join('.')}`).filter((s) => s.length > 1)),
    ];
    let items = config.items;
    for (const cand of itemCandidates) {
      const n = await page.locator(cand).count();
      attempts.push(`heal: item container candidate "${cand}" — ${n} match(es) on the page`);
      if (n >= config.minItems) {
        items = cand;
        break;
      }
    }

    // ---- rediscover every field ------------------------------------------
    const fields: FieldConfig[] = [];
    for (const f of config.fields) {
      const values = [...new Set(baseline.map((b) => (b[f.name] ?? '').trim()).filter(Boolean))];
      if (!values.length) {
        attempts.push(`heal: no baseline values for field "${f.name}" — keeping selector "${f.selector}"`);
        fields.push(f);
        continue;
      }

      const own = await matchByText(page, values);
      const candidates = [...new Set(own.map(sel))];
      if (!candidates.length) {
        attempts.push(`heal: field "${f.name}" — no element matches any known value; keeping "${f.selector}"`);
        fields.push(f);
        continue;
      }

      // Prefer the candidate that matches about as many times as there are
      // items — a selector matching far more is probably a container.
      let chosen = f.selector;
      let bestScore = Infinity;
      for (const cand of candidates) {
        const n = await page.locator(cand).count();
        attempts.push(`heal: field "${f.name}" — candidate "${cand}" (${n} match(es))`);
        const score = Math.abs(n - known.length);
        if (score < bestScore) {
          bestScore = score;
          chosen = cand;
        }
      }
      fields.push({ name: f.name, selector: chosen });
    }

    const candidate: ScraperConfig = { ...config, items, fields };

    // ---- the gate: verify on the live page before shipping anything -------
    attempts.push(
      `heal: verifying "${items}" + ${fields.map((f) => `${f.name}:"${f.selector}"`).join(', ')} on the live page…`,
    );
    const check: Page = await browser.newPage();
    try {
      const extracted = await extract(candidate, check);
      const v = validate(candidate, extracted, baseline);
      if (v.ok) {
        attempts.push(
          `heal: PASS — ${extracted.length} item(s), every known "${id}" present. Shipping the repair.`,
        );
        return { repaired: true, attempts, config: candidate, verified: extracted };
      }
      attempts.push(`heal: FAIL — ${v.issues.join('; ')}. Nothing shipped.`);
      return { repaired: false, attempts, config, verified: null };
    } finally {
      await check.close();
    }
  } finally {
    await page.close();
  }
}
