import type { ScraperConfig } from '../src/scraper.js';

/**
 * One redesign scenario in the repair benchmark.
 *
 * Each scenario is a "before" (the page the baseline was captured from) and an
 * "after" (the redesign the healer must survive). `expect` states what a
 * correct outcome is — including the refusals, because refusing to ship a
 * wrong repair is a success, not a failure.
 */
export interface BenchmarkScenario {
  name: string;
  /** The kinds of repair this scenario exercises, for the report. */
  kind: 'text' | 'llm' | 'refusal';
  /** Markup served while the baseline is captured. */
  before: string;
  /** Markup served when heal() runs — the redesign. */
  after: string;
  /** The target config; the harness fills in the local server URL. */
  config: Omit<ScraperConfig, 'url'>;
  /** Canned LLM proposals, in order. When present, the harness arms the LLM
   *  pass with a repair budget of one per proposal. */
  llmProposals?: string[];
  /** What counts as a pass. */
  expect: {
    repaired: boolean;
    /** Identity values the repaired config must still extract from the
     *  after page (the "is the data actually right" check). */
    identities?: string[];
    /** Substrings every successful run's log must contain. */
    attemptIncludes?: string[];
  };
}

const SET_A = ['Wireless Mouse', 'Mechanical Keyboard', 'USB-C Hub', '4K Monitor'];
const SET_B = ['Ergo Mouse Pro', 'TKL Mechanical Keyboard', 'USB-C Hub 8-in-1', '4K Monitor 120Hz'];
const SET_C = [...SET_A, 'Ergonomic Chair', 'Desk Lamp'];

const shop = (rows: [string, string][], opts: { card: string; name: string; price: string }): string =>
  `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
  rows.map(([name, price]) =>
    `<article class="${opts.card}"><h2 class="${opts.name}">${name}</h2><p class="${opts.price}">${price}</p></article>`).join('') +
  `</main></body></html>`;

const v1 = shop([
  ['Wireless Mouse', '$24.99'], ['Mechanical Keyboard', '$89.00'],
  ['USB-C Hub', '$39.50'], ['4K Monitor', '$299.00'],
], { card: 'product-card', name: 'name', price: 'price' });

const v2 = shop([
  ['Wireless Mouse', '$24.99'], ['Mechanical Keyboard', '$89.00'],
  ['USB-C Hub', '$39.50'], ['4K Monitor', '$299.00'],
], { card: 'item', name: 'title', price: 'amount' });

const v3 = shop([
  ['Ergo Mouse Pro', '$34.99'], ['TKL Mechanical Keyboard', '$99.00'],
  ['USB-C Hub 8-in-1', '$44.50'], ['4K Monitor 120Hz', '$329.00'],
], { card: 'tile', name: 'title', price: 'cost' });

const cfg = (
  items: string,
  fields: { name: string; selector: string }[],
  minItems = 4,
): Omit<ScraperConfig, 'url'> => ({
  items,
  fields,
  identityField: fields[0]!.name,
  minItems,
});

export const scenarios: BenchmarkScenario[] = [
  // ---- the text pass: the data survives, the markup doesn't --------------
  {
    name: 'class renames, same data',
    kind: 'text',
    before: v1,
    after: v2,
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: { repaired: true, identities: SET_A },
  },
  {
    name: 'new wrapper layers between container and fields',
    kind: 'text',
    before: v1,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<section class="item"><div class="card-inner"><h2 class="title">${n}</h2>` +
        `<p class="amount">${['$24.99', '$89.00', '$39.50', '$299.00'][i]}</p></div></section>`).join('') +
      `</main></body></html>`,
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: { repaired: true, identities: SET_A },
  },
  {
    name: 'one field renamed, the rest survive',
    kind: 'text',
    before: v1,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="product-card"><h2 class="name">${n}</h2>` +
        `<p class="amount">${['$24.99', '$89.00', '$39.50', '$299.00'][i]}</p></article>`).join('') +
      `</main></body></html>`,
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: {
      repaired: true,
      identities: SET_A,
      attemptIncludes: ['field "price"', 'amount'],
    },
  },
  {
    name: 'flat list becomes a card grid',
    kind: 'text',
    before: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1><ul>` +
      SET_A.map((n, i) =>
        `<li class="product"><span class="name">${n}</span><span class="price">${['$24.99', '$89.00', '$39.50', '$299.00'][i]}</span></li>`).join('') +
      `</ul></main></body></html>`,
    after: shop([
      ['Wireless Mouse', '$24.99'], ['Mechanical Keyboard', '$89.00'],
      ['USB-C Hub', '$39.50'], ['4K Monitor', '$299.00'],
    ], { card: 'tile', name: 'title', price: 'amount' }),
    config: cfg('.product', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: { repaired: true, identities: SET_A },
  },
  {
    name: 'URL-valued field renamed',
    kind: 'text',
    before: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="product-card"><h2 class="name">${n}</h2>` +
        `<a class="link">https://store.example.com/item/${i + 1}</a></article>`).join('') +
      `</main></body></html>`,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="item"><h2 class="title">${n}</h2>` +
        `<a class="href">https://store.example.com/item/${i + 1}</a></article>`).join('') +
      `</main></body></html>`,
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'link', selector: '.link' }]),
    expect: { repaired: true, identities: SET_A },
  },

  // ---- the LLM pass: the data itself changed -----------------------------
  {
    name: 'values + structure changed (pure LLM)',
    kind: 'llm',
    before: v1,
    after: v3,
    llmProposals: ['{"items":".tile","fields":{"name":".title","price":".cost"}}'],
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: { repaired: true, identities: SET_B },
  },
  {
    name: 'currency sign dropped (price → number stays compatible)',
    kind: 'llm',
    before: v1,
    after: shop([
      ['Wireless Mouse', '24.99'], ['Mechanical Keyboard', '89.00'],
      ['USB-C Hub', '39.50'], ['4K Monitor', '299.00'],
    ], { card: 'item', name: 'title', price: 'amount' }),
    llmProposals: ['{"items":".item","fields":{"name":".title","price":".amount"}}'],
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: { repaired: true, identities: SET_A },
  },
  {
    name: 'date format changed, field renamed',
    kind: 'llm',
    before: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="product-card"><h2 class="name">${n}</h2>` +
        `<p class="date">${['Jan 5, 2026', 'Feb 2, 2026', 'Mar 9, 2026', 'Apr 6, 2026'][i]}</p></article>`).join('') +
      `</main></body></html>`,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="item"><h2 class="title">${n}</h2>` +
        `<p class="release">${['2026-01-05', '2026-02-02', '2026-03-09', '2026-04-06'][i]}</p></article>`).join('') +
      `</main></body></html>`,
    llmProposals: ['{"items":".item","fields":{"name":".title","date":".release"}}'],
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'date', selector: '.date' }]),
    expect: { repaired: true, identities: SET_A },
  },
  {
    name: 'identity values change case (no text anchor)',
    kind: 'llm',
    before: v1,
    after: shop([
      ['WIRELESS MOUSE', '$24.99'], ['MECHANICAL KEYBOARD', '$89.00'],
      ['USB-C HUB', '$39.50'], ['4K MONITOR', '$299.00'],
    ], { card: 'item', name: 'title', price: 'amount' }),
    llmProposals: ['{"items":".item","fields":{"name":".title","price":".amount"}}'],
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: {
      repaired: true,
      identities: ['WIRELESS MOUSE', 'MECHANICAL KEYBOARD', 'USB-C HUB', '4K MONITOR'],
    },
  },

  // ---- the retry loop: a wrong guess, feedback, a corrected one ----------
  {
    name: 'LLM wrong guess first, learns from the refusal, corrects',
    kind: 'llm',
    before: v1,
    after: v3,
    llmProposals: [
      '{"items":".does-not-exist","fields":{"name":".title","price":".cost"}}',
      '{"items":".tile","fields":{"name":".title","price":".cost"}}',
    ],
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: {
      repaired: true,
      identities: SET_B,
      attemptIncludes: ['attempt 1 FAILED', 'attempt 2 PASS'],
    },
  },
  {
    name: 'LLM binds price to prose, the value-type gate refuses, it corrects',
    kind: 'llm',
    before: v1,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog — spring refresh</h1>` +
      SET_B.map((n, i) =>
        `<article class="tile"><h3 class="title">${n}</h3>` +
        `<span class="badge">${['On sale', 'bestseller', 'new', 'low stock'][i]}</span>` +
        `<p class="cost">${['$34.99', '$99.00', '$44.50', '$329.00'][i]}</p></article>`).join('') +
      `</main></body></html>`,
    llmProposals: [
      '{"items":".tile","fields":{"name":".title","price":".badge"}}',
      '{"items":".tile","fields":{"name":".title","price":".cost"}}',
    ],
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: {
      repaired: true,
      identities: SET_B,
      attemptIncludes: ['no longer look like a price', 'attempt 2 PASS'],
    },
  },

  // ---- the refusals: shipping nothing is the correct repair --------------
  {
    name: 'price selector binds prose — refused, nothing ships',
    kind: 'refusal',
    before: v1,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog — new pricing</h1>` +
      SET_A.map((n, i) =>
        `<section class="item"><h2 class="title">${n}</h2>` +
        `<p class="price">Price on request</p>` +
        `<p class="amount">${['$29.99', '$94.00', '$42.50', '$319.00'][i]}</p></section>`).join('') +
      `</main></body></html>`,
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: {
      repaired: false,
      attemptIncludes: ['no longer look like a price'],
    },
  },
  {
    name: 'prices vanish from half the items — refused, nothing ships',
    kind: 'refusal',
    before: v1,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      `<article class="item"><h2 class="title">Wireless Mouse</h2><p class="amount">$24.99</p></article>` +
      `<article class="item"><h2 class="title">Mechanical Keyboard</h2><p class="amount">$89.00</p></article>` +
      `<article class="item"><h2 class="title">USB-C Hub</h2><p class="amount"></p></article>` +
      `<article class="item"><h2 class="title">4K Monitor</h2><p class="amount"></p></article>` +
      `</main></body></html>`,
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }]),
    expect: {
      repaired: false,
      attemptIncludes: ['field "price" is empty'],
    },
  },
  {
    name: 'attribute-valued field moved — cannot be text-anchored, refused',
    kind: 'refusal',
    before: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="product-card"><h2 class="name">${n}</h2>` +
        `<img class="image" src="https://cdn.example.com/img/item${i + 1}.png" /></article>`).join('') +
      `</main></body></html>`,
    after: `<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>` +
      SET_A.map((n, i) =>
        `<article class="item"><h2 class="title">${n}</h2>` +
        `<img class="photo" src="https://cdn.example.com/img/item${i + 1}.png" /></article>`).join('') +
      `</main></body></html>`,
    // The healer anchors on visible text; a selector whose value lives in an
    // attribute has no text to find, so the field keeps its dead selector and
    // the repair is refused — correctly: shipping without the image would
    // silently corrupt the data. This is the documented envelope, not a miss.
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'image', selector: '.image' }]),
    expect: {
      repaired: false,
      attemptIncludes: ['field "image" is empty'],
    },
  },
  {
    name: 'assortment thinned (2 of 6 identities gone) — refused, alerts instead',
    kind: 'refusal',
    before: shop([
      ['Wireless Mouse', '$24.99'], ['Mechanical Keyboard', '$89.00'],
      ['USB-C Hub', '$39.50'], ['4K Monitor', '$299.00'],
      ['Ergonomic Chair', '$199.00'], ['Desk Lamp', '$24.00'],
    ], { card: 'product-card', name: 'name', price: 'price' }),
    after: shop([
      ['Wireless Mouse', '$24.99'], ['Mechanical Keyboard', '$89.00'],
      ['USB-C Hub', '$39.50'], ['4K Monitor', '$299.00'],
    ], { card: 'item', name: 'title', price: 'amount' }),
    config: cfg('.product-card', [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }], 4),
    expect: {
      repaired: false,
      attemptIncludes: ['missing known value'],
    },
  },
];
