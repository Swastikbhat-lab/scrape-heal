import type { Page } from 'playwright';
import type { ScraperConfig, ExtractedItem } from './scraper.js';

/**
 * Where to reach the model. Any OpenAI-compatible chat-completions endpoint
 * works — OpenAI, OpenRouter, Groq, Ollama, LM Studio. Nothing here depends on
 * an SDK; a plain fetch is the whole client.
 *
 * The CLI wires these from `--llm-*` flags, the config file, or the env:
 *   SCRAPE_HEAL_LLM_API_KEY, SCRAPE_HEAL_LLM_MODEL, SCRAPE_HEAL_LLM_BASE_URL
 */
export interface LLMOptions {
  apiKey?: string;
  /** e.g. https://api.openai.com/v1 (default), https://openrouter.ai/api/v1, http://localhost:11434/v1 */
  baseUrl?: string;
  model?: string;
  /** Repair budget: how many propose → verify attempts before giving up
   *  (default 3, max 5). A failed attempt's feedback is fed back each time. */
  maxAttempts?: number;
}

export interface HealProposal {
  items: string;
  fields: Record<string, string>;
}

/** One remembered, verified repair for a site — the loop's "this is how this
 *  site breaks" knowledge, carried into future heal sessions. */
export interface LLMSuccess {
  /** ISO time the repair was verified and shipped. */
  at: string;
  /** Selector signature of the config that was broken (items + fields). */
  old: string;
  proposal: HealProposal;
}

/**
 * Per-site LLM repair memory, persisted in watchdog state. Successes prime
 * future prompts (the site has broken this way before); misses are proposals
 * that failed verification, so the model doesn't repeat them.
 */
export interface SiteLLMMemory {
  /** Site origin the memory applies to. */
  site: string;
  /** Verified repairs, newest first, capped. */
  successes: LLMSuccess[];
  /** Failed proposals (as one-line summaries), newest first, capped. */
  misses: string[];
}

const SUCCESS_CAP = 3;
const MISS_CAP = 5;

/**
 * Fold one heal outcome into the per-site memory (new object; does not mutate
 * the previous one). Successes are deduped by proposal and capped; misses are
 * deduped one-line summaries, capped.
 */
export function rememberLLM(
  prev: SiteLLMMemory | undefined,
  outcome: { at: string; oldSig: string; ok: boolean; proposal?: HealProposal; failure?: string },
): SiteLLMMemory {
  const base: SiteLLMMemory = prev ?? { site: '', successes: [], misses: [] };
  if (outcome.ok && outcome.proposal) {
    const successes = [
      { at: outcome.at, old: outcome.oldSig, proposal: outcome.proposal },
      ...base.successes.filter(
        (s) => JSON.stringify(s.proposal) !== JSON.stringify(outcome.proposal),
      ),
    ].slice(0, SUCCESS_CAP);
    return { ...base, successes };
  }
  if (outcome.failure) {
    const entry = `${outcome.oldSig} → ${JSON.stringify(outcome.proposal ?? 'invalid reply')} — ${outcome.failure}`;
    const misses = [entry, ...base.misses.filter((m) => m !== entry)].slice(0, MISS_CAP);
    return { ...base, misses };
  }
  return base;
}

export interface SkeletonNode {
  tag: string;
  cls: string[];
  id: string;
  /** Short text sample, only on leaf-ish nodes — this is where the new values live. */
  txt: string;
  n: number;
}

/**
 * A compact structural outline of the page: every element as
 * `{ tag, classes, id, text sample, child count }`, in document order,
 * capped so a large page still fits in a prompt. The text samples are what
 * let the model see *where* data now lives even when the values changed.
 *
 * Built with `new Function` on purpose — same reason as the text matcher in
 * heal.ts: bundlers annotate ordinary functions with helpers (esbuild's
 * `__name`) that are invisible inside a Playwright `page.evaluate` context,
 * and a missing helper throws in the browser.
 */
const SKELETON_CODE = `
  const maxNodes = 400;
  const out = [];
  const isClass = (c) => /^[a-zA-Z_][\\w-]*$/.test(c);
  const walk = (el, depth) => {
    if (out.length >= maxNodes || depth > 30) return;
    const cls = [...el.classList].filter(isClass).slice(0, 8);
    let txt = '';
    if (el.childNodes.length === 1 && el.firstChild && el.firstChild.nodeType === 3) {
      txt = (el.textContent || '').trim().slice(0, 60);
    }
    out.push({ tag: el.tagName.toLowerCase(), cls, id: el.id || '', txt, n: el.children.length });
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  return out;
`;

export async function describeStructure(page: Page): Promise<SkeletonNode[]> {
  const fn = new Function(SKELETON_CODE) as () => SkeletonNode[];
  return page.evaluate(fn);
}

export interface ProposeInput {
  config: ScraperConfig;
  baseline: ExtractedItem[];
  skeleton: SkeletonNode[];
  llm: LLMOptions;
  /** Failed proposals from earlier attempts in this session, with the
   *  verification feedback — so the model can correct itself. */
  history?: { proposal?: HealProposal; failure: string }[];
  /** Per-site memory from previous heal sessions (successes + misses). */
  memory?: SiteLLMMemory;
}

/**
 * Ask the model to map the old config's intent onto the current structure.
 *
 * The proposal is just a proposal: the caller re-extracts with it and only
 * ships it if the verify gate passes. Propose with the model, verify with the
 * browser — that split is the whole design. Failures are fed back through
 * `history`, and per-site `memory` accumulates across sessions, so the model
 * learns from its own misses.
 */
export async function proposeWithLLM(input: ProposeInput): Promise<HealProposal> {
  const { llm } = input;
  const baseUrl = (llm.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: llm.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildPrompt(input) }],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status} ${res.statusText})`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM response contained no content');

  return parseProposal(content);
}

/** Parse the model's reply, tolerating markdown code fences. Throws on garbage. */
export function parseProposal(content: string): HealProposal {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM proposal was not JSON: ${cleaned.slice(0, 80)}…`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('LLM proposal must be a JSON object');
  }

  const { items, fields } = obj as { items?: unknown; fields?: unknown };
  if (typeof items !== 'string' || !items.trim()) {
    throw new Error('LLM proposal is missing a string "items" selector');
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new Error('LLM proposal is missing a "fields" object');
  }

  const mapped: Record<string, string> = {};
  for (const [name, sel] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof sel === 'string' && sel.trim()) mapped[name] = sel.trim();
  }
  if (!Object.keys(mapped).length) {
    throw new Error('LLM proposal contained no usable field selectors');
  }

  return { items: items.trim(), fields: mapped };
}

function buildPrompt(input: ProposeInput): string {
  const { config, baseline, skeleton } = input;
  const parts = [
    'You are fixing CSS selectors for a web scraper after a site redesign.',
    'The old selectors stopped matching — and worse, the VALUES on the page changed too,',
    'so nothing can be found by text. Infer intent from structure, not text.',
    '',
    'OLD CONFIG:',
    JSON.stringify(
      { items: config.items, fields: config.fields, identityField: config.identityField },
      null,
      2,
    ),
    '',
    'DATA THE OLD CONFIG USED TO EXTRACT (sample of the last good run):',
    JSON.stringify(baseline.slice(0, 5), null, 2),
    '',
    'CURRENT PAGE STRUCTURE — each node is {tag, classes, id, short text sample, child count}, in document order:',
    JSON.stringify(skeleton),
    '',
    'The item container repeats several times on the page. Field selectors are scoped INSIDE each item container.',
    'Reuse surviving classes where possible; prefer classes over structural position.',
    'Reply with ONLY a JSON object, no prose, no markdown fences:',
    '{"items": "<container selector>", "fields": {"<field name>": "<selector>"}}',
  ];

  if (input.memory) {
    const mem = ['', 'REMEMBERED CONTEXT FOR THIS SITE (from previous heal sessions):'];
    if (input.memory.successes.length) {
      mem.push('Verified repairs this site has had before — the site has broken this way once; it can again:');
      for (const s of input.memory.successes) {
        mem.push(`- at ${s.at}: old ${s.old} → new ${JSON.stringify(s.proposal)}`);
      }
    } else {
      mem.push('(no verified repairs remembered yet)');
    }
    if (input.memory.misses.length) {
      mem.push('Proposals that FAILED verification before — do not repeat them:');
      for (const m of input.memory.misses) mem.push(`- ${m}`);
    }
    parts.push(mem.join('\n'));
  }

  if (input.history?.length) {
    const hist = [
      '',
      'YOUR PREVIOUS ATTEMPTS IN THIS SESSION FAILED — the browser rejected these proposals. Learn from them and correct:',
      ...input.history.map(
        (h) => `- proposed ${JSON.stringify(h.proposal ?? 'invalid reply')} — failure: ${h.failure}`,
      ),
    ];
    parts.push(hist.join('\n'));
  }

  return parts.join('\n');
}
