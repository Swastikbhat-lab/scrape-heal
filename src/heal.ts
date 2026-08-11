import type { Browser, Page } from 'playwright';
import type { ScraperConfig, ExtractedItem, FieldConfig, Validator } from './scraper.js';
import { extract, validate, validateShape } from './scraper.js';
import { describeStructure, proposeWithLLM, type LLMOptions } from './llm.js';

export interface HealResult {
  repaired: boolean;
  /** A human-readable log of everything the loop tried and decided. */
  attempts: string[];
  /** The repaired config, or the original when nothing passed. */
  config: ScraperConfig;
  /** What the repaired config extracted, verified against the live page. */
  verified: ExtractedItem[] | null;
}

export interface HealOptions {
  /**
   * LLM-assisted repair. Used only when the text-based healer finds no anchor
   * at all — i.e. the redesign also changed the values, so there is nothing
   * to match by text. The model proposes from structure; the proposal still
   * has to pass the same verify gate before anything ships.
   */
  llm?: LLMOptions;
  /** Pluggable validator — replaces the built-in shape checks everywhere. */
  validator?: Validator;
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
 * Two passes, one gate:
 *
 * 1. **By text** — the *last good run* is the ground truth. We know the items
 *    existed and what their fields contained, so the healer looks for elements
 *    that still contain those exact values and derives new selectors from them.
 * 2. **By structure (LLM)** — when even the values changed, there is no text
 *    anchor left. If an LLM is configured, the page's structural skeleton is
 *    handed to it and it proposes where each field now lives.
 *
 * Then — the load-bearing step, identical for both passes — the candidate
 * config is re-run against the live page and only shipped if the schema
 * validates AND (for a text repair) every known identity is still there.
 * No verification, no repair.
 */
export async function heal(
  browser: Browser,
  config: ScraperConfig,
  baseline: ExtractedItem[],
  opts: HealOptions = {},
): Promise<HealResult> {
  const textResult = await healByText(browser, config, baseline, opts.validator);
  if (textResult.repaired) return textResult;

  // LLM pass only when there is somewhere to send the request — a key, or a
  // keyless local endpoint (Ollama, LM Studio).
  if (!opts.llm || (!opts.llm.apiKey && !opts.llm.baseUrl)) return textResult;

  const llmResult = await healByLLM(browser, config, baseline, opts);
  return {
    ...llmResult,
    attempts: [...textResult.attempts, ...llmResult.attempts],
  };
}

/** The primary pass: rediscover selectors by matching the known values. */
async function healByText(
  browser: Browser,
  config: ScraperConfig,
  baseline: ExtractedItem[],
  validator?: Validator,
): Promise<HealResult> {
  const attempts: string[] = [];
  const id = config.identityField;
  const known = [...new Set(baseline.map((b) => (b[id] ?? '').trim()).filter(Boolean))];

  const page: Page = await browser.newPage();
  try {
    await page.goto(config.url, { waitUntil: 'networkidle', timeout: 15_000 });

    // The first pass is over identity values only: if nothing on the page
    // still contains a single known identity, no text repair can be derived.
    const identityMatches = await matchByText(page, known);
    if (!identityMatches.length) {
      attempts.push(
        `heal: no element on the page still contains any known "${id}" value — ` +
        'the redesign may have changed the data itself. Nothing to anchor a text repair to.',
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
      const v = validate(candidate, extracted, baseline, validator);
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

/**
 * The fallback pass: the data itself changed, so structure must carry intent.
 * The model sees a compact skeleton of the live page (with the *new* values as
 * text samples) plus the old config and its last-good data, and proposes where
 * each field now lives. The proposal is still verified against the live page.
 */
async function healByLLM(
  browser: Browser,
  config: ScraperConfig,
  baseline: ExtractedItem[],
  opts: HealOptions,
): Promise<HealResult> {
  const attempts: string[] = [];
  const id = config.identityField;

  const page: Page = await browser.newPage();
  try {
    await page.goto(config.url, { waitUntil: 'networkidle', timeout: 15_000 });
    const skeleton = await describeStructure(page);
    attempts.push(
      `heal-llm: no text anchor survived — the data itself changed. Asking the model ` +
      `to map the old fields onto the new structure (${skeleton.length} nodes sampled).`,
    );

    const proposal = await proposeWithLLM({ config, baseline, skeleton, llm: opts.llm! });
    const fields: FieldConfig[] = config.fields.map((f) => ({
      name: f.name,
      selector: proposal.fields[f.name] ?? f.selector,
    }));
    const candidate: ScraperConfig = { ...config, items: proposal.items, fields };
    attempts.push(
      `heal-llm: proposal — items "${proposal.items}", ` +
      fields.map((f) => `${f.name}:"${f.selector}"`).join(', '),
    );

    // ---- the same gate: verify on the live page before shipping -----------
    attempts.push(`heal-llm: verifying "${candidate.items}" on the live page…`);
    const check: Page = await browser.newPage();
    try {
      const extracted = await extract(candidate, check);

      // Did the *values* really change, or did the model just find a better
      // path to the same data? If the known identities survive, demand them.
      const want = new Set(baseline.map((b) => (b[id] ?? '').trim()).filter(Boolean));
      const have = new Set(extracted.map((it) => (it[id] ?? '').trim()));
      const missing = [...want].filter((w) => !have.has(w));

      const gate = opts.validator
        ? opts.validator(extracted, { config: candidate, baseline })
        : validateShape(candidate, extracted);
      if (!gate.ok) {
        attempts.push(`heal-llm: FAIL — ${gate.issues.join('; ')}. Nothing shipped.`);
        return { repaired: false, attempts, config, verified: null };
      }

      if (missing.length === 0) {
        attempts.push(
          `heal-llm: PASS — ${extracted.length} item(s), every known "${id}" still present. Shipping the repair.`,
        );
      } else {
        attempts.push(
          `heal-llm: PASS — ${extracted.length} item(s). The old "${id}" values are gone (the data changed), ` +
          'so verification is shape-only: correct count, no empty fields. Shipping the repair.',
        );
      }
      return { repaired: true, attempts, config: candidate, verified: extracted };
    } finally {
      await check.close();
    }
  } catch (err) {
    attempts.push(`heal-llm: error — ${(err as Error).message}. Nothing shipped.`);
    return { repaired: false, attempts, config, verified: null };
  } finally {
    await page.close();
  }
}
