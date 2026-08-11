/**
 * The repair benchmark — how often does the loop actually heal a redesign?
 *
 *   npm run benchmark                 # run every scenario, print the rate
 *   npm run benchmark -- --min-rate 0.9   # exit 1 when the rate falls below
 *
 * Every scenario serves a real page, captures a real baseline from it,
 * swaps in the redesign, runs the real healer (browser + verify gate, mock
 * LLM where the data itself changed), and judges the outcome — including the
 * refusals, where shipping nothing is the correct repair. The rate is the
 * one number that says whether "self-healing" is true or just a demo.
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { ExtractedItem } from '../src/scraper.js';
import { extract, validateShape } from '../src/scraper.js';
import { verifyValueTypes } from '../src/valuetypes.js';
import { heal } from '../src/heal.js';
import { scenarios, type BenchmarkScenario } from './scenarios.js';

// ------------------------------------------------------------- harness

/** Serve one HTML page, switchable between the before/after redesigns. */
function startSite() {
  const current = { html: '' };
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(current.html);
  });
  return new Promise<{ url: string; serve: (html: string) => void; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({
        url: `http://127.0.0.1:${port}/`,
        serve: (html) => { current.html = html; },
        close: () => server.close(),
      });
    });
  });
}

/** A stub OpenAI-compatible endpoint that serves the scenarios' canned
 *  proposals in order — the benchmark never calls a real model. */
function startMockLLM(proposals: string[]) {
  let i = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const content = proposals[Math.min(i, proposals.length - 1)] ?? '{}';
      i++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise<{ baseUrl: string; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

// ------------------------------------------------------------- judging

interface Verdict {
  pass: boolean;
  detail: string;
  /** 'text' | 'llm' — which pass actually shipped the repair. */
  via?: 'text' | 'llm';
  ms: number;
}

async function judgeScenario(
  browser: Browser,
  s: BenchmarkScenario,
  url: string,
  llmBaseUrl: string | undefined,
  baseline: ExtractedItem[],
): Promise<Verdict> {
  const t0 = Date.now();
  const config = { ...s.config, url };
  const llm = s.llmProposals
    ? { baseUrl: llmBaseUrl!, maxAttempts: s.llmProposals.length }
    : undefined;
  const result = await heal(browser, config, baseline, llm ? { llm } : {});

  const attempts = result.attempts.join('\n');

  if (result.repaired !== s.expect.repaired) {
    return {
      pass: false,
      ms: Date.now() - t0,
      detail: `expected repaired:${s.expect.repaired}, got repaired:${result.repaired}`,
    };
  }

  if (!result.repaired) {
    // A refusal: correct when nothing shipped and (when asked) for the
    // right reason.
    const reasonsOk = (s.expect.attemptIncludes ?? []).every((x) => attempts.includes(x));
    return {
      pass: reasonsOk && result.verified === null,
      ms: Date.now() - t0,
      detail: reasonsOk
        ? 'correctly refused — nothing shipped'
        : `refused, but not for the expected reason (missing: ${s.expect.attemptIncludes!.filter((x) => !attempts.includes(x)).join(', ')})`,
    };
  }

  // A repair is only a repair if the shipped config re-extracts the right
  // data from the live page — same shape, same value kinds, same identities.
  const checkPage: Page = await browser.newPage();
  try {
    const check = await extract(result.config, checkPage);
    const shape = validateShape(result.config, check.items);
    const types = verifyValueTypes(result.config.fields, check.items, baseline);
    const id = config.identityField;
    const want = new Set(s.expect.identities ?? []);
    const have = new Set(check.items.map((it) => it[id] ?? ''));
    const missing = [...want].filter((w) => !have.has(w));

    const problems: string[] = [];
    if (check.items.length === 0) problems.push('shipped config extracts nothing');
    if (!shape.ok) problems.push(shape.issues.join('; '));
    if (types.length) problems.push(types.join('; '));
    if (missing.length) problems.push(`missing identities: ${missing.join(', ')}`);
    const reasonsOk = (s.expect.attemptIncludes ?? []).every((x) => attempts.includes(x));
    if (!reasonsOk) problems.push(`expected log lines missing: ${s.expect.attemptIncludes!.filter((x) => !attempts.includes(x)).join(', ')}`);

    const via: 'text' | 'llm' = attempts.includes('heal-llm:') ? 'llm' : 'text';
    return {
      pass: problems.length === 0,
      ms: Date.now() - t0,
      via,
      detail: problems.length ? problems.join(' | ') : `shipped and verified — ${check.items.length} item(s) via ${via}`,
    };
  } finally {
    await checkPage.close();
  }
}

// ------------------------------------------------------------- report

/** Read a flag's value, accepting both `--flag value` and `--flag=value`. */
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main() {
  const minRate = Number(argValue('--min-rate') ?? NaN);
  const browser = await chromium.launch();
  const site = await startSite();
  const allProposals = scenarios.flatMap((s) => s.llmProposals ?? []);
  const llm = await startMockLLM(allProposals);

  const verdicts: { s: BenchmarkScenario; v: Verdict }[] = [];
  try {
    for (const s of scenarios) {
      const page: Page = await browser.newPage();
      try {
        // Capture the baseline from the real "before" page…
        site.serve(s.before);
        const baseline = (await extract({ ...s.config, url: site.url }, page)).items;
        // …then the redesign goes live and the healer must survive it.
        site.serve(s.after);
        const v = await judgeScenario(browser, s, site.url, allProposals.length ? llm.baseUrl : undefined, baseline);
        verdicts.push({ s, v });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await llm.close();
    site.close();
    await browser.close();
  }

  // ---- report ------------------------------------------------------------
  const width = Math.max(...verdicts.map(({ s }) => s.name.length));
  console.log('\nrepair benchmark — the loop vs. real redesigns\n');
  for (const { s, v } of verdicts) {
    const mark = v.pass ? '✔' : '✘';
    const tag = s.kind === 'refusal' ? 'refusal' : (v.via ?? s.kind);
    console.log(` ${mark} ${s.name.padEnd(width)}  (${tag.padEnd(7)}) ${v.detail}  ${(v.ms / 1000).toFixed(1)}s`);
  }

  const passed = verdicts.filter(({ v }) => v.pass).length;
  const total = verdicts.length;
  const rate = passed / total;
  console.log('\n' + '─'.repeat(70));
  for (const kind of ['text', 'llm', 'refusal'] as const) {
    const inKind = verdicts.filter(({ s }) => s.kind === kind);
    const passedInKind = inKind.filter(({ v }) => v.pass).length;
    console.log(`  ${kind.padEnd(8)} ${passedInKind}/${inKind.length}`);
  }
  console.log(`  rate     ${passed}/${total} — ${(rate * 100).toFixed(1)}%`);
  console.log('─'.repeat(70) + '\n');

  if (!Number.isNaN(minRate) && rate < minRate) {
    console.error(`benchmark below --min-rate ${minRate} (got ${(rate * 100).toFixed(1)}%)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
