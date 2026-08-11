import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ScraperConfig, ExtractedItem, Validator } from './scraper.js';
import { extract, validate } from './scraper.js';
import { heal, siteOrigin } from './heal.js';
import type { LLMOptions, SiteLLMMemory } from './llm.js';
import { sendAlert, type AlertChannel } from './alert.js';
import { authenticate, type AuthConfig, type AuthHandle } from './auth.js';
import { captureEvidence, type CycleEvidence } from './evidence.js';
import { playwrightRows, type RowFetch, type RowResult } from './source.js';
import {
  ProxyPool, proxyLaunchOptions,
  type ProxyEntry, type ProxyPoolOptions,
} from './proxy.js';
import { detectGrid, extractByGrid } from './visual.js';
import type { PaginationConfig, PagedResult } from './pagination.js';
import { extractAllPages } from './pagination.js';
import type { Pipeline } from './pipeline.js';
import { runPipelines } from './pipeline.js';
import { tryExtractors, tryHealers, applyTransforms } from './plugins.js';
import {
  diffChanges, formatChanges, matchesThresholds, reportHasChanges,
  type ChangeReport, type ChangeThreshold,
} from './changes.js';

export interface LedgerEntry {
  /** A selector config proven against this target before. */
  config: ScraperConfig;
  /** When it was last proven (healthy run or verified repair). */
  verifiedAt: string;
  /** How many red cycles this entry has already repaired from memory. */
  hits: number;
}

export interface WatchState {
  config: ScraperConfig;
  /** The last extraction that passed validation — the ground truth for repair. */
  baseline: ExtractedItem[];
  /** Previously-proven configs, newest first — the memory that makes a
   *  flip-flopping site cost nothing after the first heal. */
  ledger: LedgerEntry[];
  /** Per-site LLM repair memory (successes + misses), keyed by site origin —
   *  what the model has learned about this site's breakage patterns. */
  llmMemory: Record<string, SiteLLMMemory>;
  lastStatus: 'healthy' | 'repaired' | 'red';
  lastCheckedAt: string;
  healedAt?: string;
  alertCount: number;
  /** When the last alert was actually sent for this target — the throttle
   *  that stops a long-broken target from pinging the channel every cycle. */
  lastAlertAt?: string;
  /** v3: the last change-watching report, for the dashboard. */
  lastChanges?: { at: string; added: number; removed: number; changed: number; lines: string[] };
  /** v3: when the last change alert was sent — its own cooldown, so a
   *  price-drop ping never suppresses a red-cycle alert or vice versa. */
  lastChangeAlertAt?: string;
  /** v3: evidence captured on the last red cycle — screenshot + DOM + status,
   *  for the dashboard and the next alert. */
  lastEvidence?: CycleEvidence;
}

export interface WatchOptions {
  /** Seconds between cycles. */
  intervalSeconds: number;
  /** Run this many cycles, then exit. Runs forever when absent. */
  cycles?: number;
  /** Where state (config + baseline) lives between runs. */
  statePath: string;
  /** Shell command run on an unhealed red cycle. Receives the alert summary
   *  via the SCRAPE_HEAL_ALERT env var. */
  onAlert?: string;
  /** How rows are obtained each cycle. Defaults to Playwright extraction;
   *  pass a command/file source to watch any other scraper. */
  fetchRows?: RowFetch;
  /** When a repair is verified and shipped, also write the new selector
   *  config here (JSON) so any external scraper can read it back. */
  writeConfigPath?: string;
  /** LLM-assisted repair, used only when the text healer finds no anchor
   *  (the redesign changed the values too). The proposal still has to pass
   *  the verify gate. */
  llm?: LLMOptions;
  /** Pluggable validator — replaces the built-in shape checks everywhere. */
  validator?: Validator;
  /** Notify humans the day a cycle breaks — Slack/Discord/webhook channels. */
  alerts?: AlertChannel;
  /** v2: Proxy pool for anti-bot rotation. */
  proxy?: ProxyPoolOptions;
  /** v2: Multi-page pagination config. */
  pagination?: PaginationConfig;
  /** v2: Data output pipelines (webhook, file, DB). */
  pipelines?: Pipeline[];
  /** v3: Change watching — diff every healthy cycle against the previous
   *  run. Enabled by default (changes are logged); `thresholds` decides
   *  which changes are worth an alert when `alerts.onChange` is set. */
  watch?: { enabled?: boolean; thresholds?: ChangeThreshold[] };
  /** v3: How many times a transient failure or block is retried within one
   *  cycle before the cycle is declared red. Default 3. */
  maxFetchAttempts?: number;
  /** v3: Refuse repairs whose field values no longer look like the kind of
   *  data the last good run produced (a `price` field yielding prose is a
   *  wrong binding, not a repair). On by default; skipped when a pluggable
   *  validator is set. */
  verifyTypes?: boolean;
  /** v2→v3: Scrape pages behind a login. The authenticated context is
   *  established once and held across every cycle — fetching, pagination,
   *  visual fallback, the ledger, healing, and evidence capture all run
   *  through it, so a login-walled page is treated like any other page. When
   *  combined with a proxy pool, the session rides along into each
   *  per-fetch proxy context. */
  auth?: AuthConfig;
  log: (line: string) => void;
}

export function loadState(statePath: string, config: ScraperConfig): WatchState {
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as WatchState;
      if (parsed.config && parsed.baseline) {
        return {
          ...parsed,
          // tolerate state written before the ledger/llmMemory existed
          ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
          llmMemory: parsed.llmMemory && typeof parsed.llmMemory === 'object'
            ? parsed.llmMemory
            : {},
        };
      }
    } catch {
      // corrupt state — start over rather than die
    }
  }
  return {
    config,
    baseline: [],
    ledger: [],
    llmMemory: {},
    lastStatus: 'healthy',
    lastCheckedAt: new Date().toISOString(),
    alertCount: 0,
  };
}

function saveState(statePath: string, state: WatchState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function runAlertHook(command: string | undefined, summary: string, evidence?: CycleEvidence): void {
  if (!command) return;
  const child = spawn(command, {
    shell: true,
    env: {
      ...process.env,
      SCRAPE_HEAL_ALERT: summary,
      SCRAPE_HEAL_EVIDENCE: evidence ? JSON.stringify(evidence) : '',
    },
  });
  child.on('error', (err) => console.error(`  alert hook failed: ${err.message}`));
}

const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;
const DEFAULT_CHANGE_ALERT_COOLDOWN_MINUTES = 60;

/**
 * True when a target's last alert is inside its cooldown window — the
 * throttle that makes "alerts at most once per N minutes" true instead of
 * "every red cycle". A cooldown of 0 (or no prior alert) never throttles.
 * Exported for tests.
 */
export function alertThrottled(
  lastAlertAt: string | undefined,
  cooldownMinutes: number,
  now: string,
): boolean {
  if (cooldownMinutes <= 0 || !lastAlertAt) return false;
  const waitedMs = Date.parse(now) - Date.parse(lastAlertAt);
  return Number.isFinite(waitedMs) && waitedMs < cooldownMinutes * 60_000;
}

/** The shell hook (exit-code world) plus the webhook channels (human world),
 *  throttled per target: the gate is passed at most once per cooldown, and
 *  the last-sent timestamp is persisted in state so the cooldown survives
 *  restarts (callers save state right after). */
//
// v3: change alerts — the same channels, a separate cooldown, and no shell
// hook (the `onAlert` command is for red cycles; a price drop is data news,
// not a breakage alarm).
async function runChangeAlerts(
  opts: { alerts?: AlertChannel; log: (line: string) => void },
  state: WatchState,
  summary: string,
  cycle: number,
  target: string,
): Promise<void> {
  const channels = opts.alerts;
  if (!channels || (!channels.slack && !channels.discord && !channels.webhook)) return;

  const cooldown = channels.changeCooldownMinutes ?? DEFAULT_CHANGE_ALERT_COOLDOWN_MINUTES;
  const now = new Date().toISOString();
  if (alertThrottled(state.lastChangeAlertAt, cooldown, now)) {
    opts.log(`  change alert throttled — already alerted within the last ${cooldown} min`);
    return;
  }
  state.lastChangeAlertAt = now;
  try {
    await sendAlert(channels, { target, cycle, summary, at: now });
    opts.log(`  change alert sent → ${Object.keys(channels).join(', ')}`);
  } catch (err) {
    opts.log(`  change alert delivery failed — ${(err as Error).message}`);
  }
}
async function runAlerts(
  opts: { onAlert?: string; alerts?: AlertChannel; log: (line: string) => void },
  state: WatchState,
  summary: string,
  cycle: number,
  target: string,
  evidence?: CycleEvidence,
): Promise<void> {
  const cooldown = opts.alerts?.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES;
  const now = new Date().toISOString();
  if (alertThrottled(state.lastAlertAt, cooldown, now)) {
    opts.log(`  alert throttled — already alerted for this target within the last ${cooldown} min; next alert once the cooldown clears`);
    return;
  }
  state.lastAlertAt = now;
  runAlertHook(opts.onAlert, summary, evidence);
  if (!opts.alerts) return;
  try {
    await sendAlert(opts.alerts, {
      target, cycle, summary, at: now,
      ...(evidence ? { evidence } : {}),
    });
    opts.log(`  alert sent → ${Object.keys(opts.alerts).join(', ')}`);
  } catch (err) {
    opts.log(`  alert delivery failed — ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- ledger ---

const LEDGER_MAX = 8;

/** A config's identity — the selectors, not the URL. Exported for tests. */
export function configSignature(config: ScraperConfig): string {
  const fields = [...config.fields].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ items: config.items, fields, identityField: config.identityField });
}

/** Remember a proven config, newest first, deduped by its selectors. Exported for tests. */
export function rememberLedger(state: WatchState, config: ScraperConfig, now: string): void {
  const sig = configSignature(config);
  const rest = state.ledger.filter((e) => configSignature(e.config) !== sig);
  state.ledger = [{ config, verifiedAt: now, hits: 0 }, ...rest].slice(0, LEDGER_MAX);
}

/**
 * Try the remembered configs against the live page, newest first, before
 * running a full heal. A config that re-extracts the current baseline is a
 * verified repair — the site flipped back to markup we've already decoded.
 */
async function tryLedger(
  browser: Browser,
  state: WatchState,
  validator?: Validator,
  context?: BrowserContext,
): Promise<{ config: ScraperConfig; data: ExtractedItem[] } | null> {
  const currentSig = configSignature(state.config);
  for (const entry of state.ledger) {
    if (configSignature(entry.config) === currentSig) continue; // this one just failed
    const page = context ? await context.newPage() : await browser.newPage();
    try {
      const extracted = await extract(entry.config, page);
      // A remembered config that now hits a block or a dead page is not a
      // flip-flop — skip it, don't ship it.
      if (extracted.failed) continue;
      const v = validate(entry.config, extracted.items, state.baseline, validator);
      if (v.ok) {
        entry.hits += 1;
        return { config: entry.config, data: extracted.items };
      }
    } catch {
      // page failed to load — try the next remembered config
    } finally {
      await page.close();
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Screenshot + DOM-dump the page that just failed, and record why.
 *
 * Uses the passed-in page when it is already on the target (the non-proxy
 * fetch navigated it); otherwise opens a fresh page and re-navigates, so a
 * proxy-path failure still leaves a receipt. Strictly best-effort — a
 * capture that fails returns a reason-only record, never an error.
 */
async function captureFailureEvidence(
  browser: Browser,
  page: Page,
  url: string,
  stateDir: string,
  targetKey: string,
  reason: string,
  status?: number,
  context?: BrowserContext,
): Promise<CycleEvidence> {
  try {
    if (page.url() === 'about:blank' && url) {
      const fresh = context ? await context.newPage() : await browser.newPage();
      try {
        await fresh.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        return await captureEvidence(fresh, stateDir, targetKey, reason, status);
      } finally {
        await fresh.close();
      }
    }
    return await captureEvidence(page, stateDir, targetKey, reason, status);
  } catch {
    return { at: new Date().toISOString(), reason, status };
  }
}

/** A reason-only evidence record (no page to look at — a crashed source). */
function reasonOnlyEvidence(reason: string, status?: number): CycleEvidence {
  return { at: new Date().toISOString(), reason, status };
}

// ---------------------------------------------------------- failure classes ---
//
// The loop never heals a page that failed to respond. Three outcomes are
// classified at fetch time (see scraper.ts): transient (5xx/timeout/network),
// block (403/429/captcha), or loaded. Transients are retried with backoff;
// blocks rotate proxies when a pool is configured, then retry. Only a page
// that actually loaded and returned wrong-shaped data is breakage — healable.

const MAX_FETCH_ATTEMPTS = 3;

const backoffMs = (attempt: number) =>
  Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 200;

/**
 * The default browser fetch, routed through the proxy pool. Each fetch runs
 * in a fresh context with the current proxy (Playwright proxies are
 * per-context), so a block can rotate to the next healthy proxy without
 * relaunching anything. A blocked or dead proxy is cooled down by the pool
 * and the next fetch picks another one.
 */
function proxyAwareFetch(
  browser: Browser,
  getConfig: () => ScraperConfig,
  pool: ProxyPool,
  log: (line: string) => void,
  authContext?: BrowserContext,
): RowFetch {
  let entry: ProxyEntry | null = null;
  return async () => {
    if (!entry) entry = pool.next();
    // With auth, the session rides along: Playwright proxies are per-context,
    // so each fresh fetch context re-applies the authenticated storage state
    // (cookies/localStorage) on top of the current proxy.
    const storageState = authContext ? await authContext.storageState() : undefined;
    const ctx = entry
      ? await browser.newContext({ proxy: proxyLaunchOptions(entry.url), ...(storageState ? { storageState } : {}) })
      : await browser.newContext({ ...(storageState ? { storageState } : {}) });
    const page = await ctx.newPage();
    try {
      const result = await extract(getConfig(), page);
      if (!entry) return result;
      if (result.failed?.kind === 'block') {
        // The site refused us — this proxy is the problem (or at least not
        // helping). Cool it down and rotate on the next attempt.
        pool.record(entry, {
          ok: false, ms: 0, status: result.status, bodySample: result.failed.message,
        });
        log(`  proxy ${entry.url} blocked — cooling it down and rotating`);
        entry = null;
      } else if (result.failed?.kind === 'transient' && !result.status) {
        // The navigation itself threw (no status) — likely a dead proxy.
        // A 5xx from the site is the site's fault; the proxy stays healthy.
        pool.record(entry, { ok: false, ms: 0 });
        entry = null;
      } else {
        pool.record(entry, { ok: true, ms: 0 });
      }
      return result;
    } finally {
      await ctx.close();
    }
  };
}

/**
 * Watch one target on a cadence.
 *
 * Each cycle: extract → validate against the last good run. Healthy runs
 * refresh the baseline (legit content changes are re-baselined, so the loop
 * tracks the real site). A red run is handed to the healer; a verified repair
 * is shipped and becomes the new baseline; an unverified one alerts loudly and
 * exits non-zero so a scheduler notices.
 *
 * Returns the process exit code: 0 when the final cycle ended healthy or
 * self-healed, 1 when it ended red.
 */
export async function runWatchdog(
  browser: Browser,
  page: Page,
  opts: WatchOptions,
  /** Full config for a real target. Overrides defaults used for fresh state. */
  configOverride?: ScraperConfig,
): Promise<number> {
  const defaults: ScraperConfig = configOverride ?? {
    url: '',
    items: '.product-card',
    fields: [
      { name: 'name', selector: '.name' },
      { name: 'price', selector: '.price' },
    ],
    identityField: 'name',
    minItems: 4,
  };
  const state = loadState(opts.statePath, defaults);

  // Persisted state resumes the last config for a target — including repaired
  // selectors — but only when it really is the same target. A different
  // requested URL means a new job: don't apply the old target's healed
  // selectors (or its baseline) to it.
  if (configOverride?.url && configOverride.url !== state.config.url) {
    state.config = configOverride;
    state.baseline = [];
    state.ledger = [];
    state.llmMemory = {};
    state.alertCount = 0;
    state.lastStatus = 'healthy';
    state.lastAlertAt = undefined; // a new job starts with a clean throttle
  }

  let config = state.config;

  // Initialize proxy pool for anti-bot rotation.
  const proxyPool = opts.proxy ? new ProxyPool(opts.proxy) : null;

  // Authenticated browsing — the session is established once and held across
  // every cycle, so a page behind a login wall is scraped, healed, and
  // evidenced like any other page. A misconfigured login is a hard stop:
  // failing fast beats silently scraping an anonymous site for days.
  let authHandle: AuthHandle | null = null;
  let authPage: Page | null = null;
  if (opts.auth) {
    try {
      authHandle = await authenticate(browser, opts.auth, opts.log);
    } catch (err) {
      opts.log(`auth failed: ${(err as Error).message} — target not scraped; fix the auth config and re-run.`);
      return 1;
    }
    if (authHandle?.context) {
      authPage = await authHandle.context.newPage();
      opts.log(`  authenticated context held across cycles (${opts.auth.kind})`);
    }
  }
  const authContext = authHandle?.context ?? undefined;
  // Every page the loop touches comes from the authenticated context when one
  // exists; otherwise the caller's page, as before.
  const loopPage = authPage ?? page;

  // The default fetch is the browser. With a proxy pool configured, each
  // fetch runs through the current proxy so a block rotates to the next one;
  // with auth, the session rides along into each per-fetch context.
  const fetchRows = opts.fetchRows ?? (proxyPool
    ? proxyAwareFetch(browser, () => config, proxyPool, opts.log, authContext)
    : playwrightRows(loopPage, () => config));

  const maxFetchAttempts = opts.maxFetchAttempts ?? MAX_FETCH_ATTEMPTS;

  // Evidence lands in <stateDir>/evidence/<target>/… — the dashboard serves
  // it from the same directory, and alerts reference it by relative path.
  const stateDir = dirname(opts.statePath);
  const targetKey = basename(opts.statePath).replace(/\.json$/, '') || 'target';

  let exitCode = 0;
  let cycle = 0;
  while (true) {
    cycle++;
    const checkedAt = new Date().toISOString();

    // ---- fetch + classify -------------------------------------------------
    // Transient failures (5xx, timeouts, network errors) are retried with
    // exponential backoff; blocks rotate proxies (when configured) and retry.
    // Only a page that actually loaded is passed on to validation — a page
    // that never responded is never handed to the healer.
    let fetchResult: RowResult = { items: null };
    for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
      fetchResult = await fetchRows();
      const kind = fetchResult.failed?.kind;
      if (!kind) break;
      const retriable = kind === 'transient' || (kind === 'block' && proxyPool);
      if (!retriable || attempt === maxFetchAttempts) break;
      const failure = fetchResult.failed;
      opts.log(
        `  ${kind} fetch failure (${failure!.message}) — attempt ${attempt}/${maxFetchAttempts}, retrying${proxyPool && kind === 'block' ? ' on the next proxy' : ''}…`,
      );
      await sleep(backoffMs(attempt));
    }
    let items = fetchResult.items;
    const fetchFailed = fetchResult.failed;

    // ---- the page itself never responded — red, alert, never heal --------
    if (fetchFailed) {
      state.lastStatus = 'red';
      state.alertCount += 1;
      state.lastCheckedAt = checkedAt;
      exitCode = 1;
      const cause = fetchFailed.kind === 'block'
        ? (proxyPool
            ? `blocked after ${maxFetchAttempts} attempt(s) through the proxy pool — ${fetchFailed.message}`
            : `blocked (${fetchFailed.message}) — configure "proxy" to rotate; nothing was healed`)
        : `site failed to respond after ${maxFetchAttempts} attempt(s) — ${fetchFailed.message}`;
      const summary = `cycle ${cycle}: ${cause}`;
      opts.log(`[cycle ${cycle}] RED — ${fetchFailed.kind === 'block' ? 'the site blocked us' : 'the site did not respond'}`);
      opts.log('━━━ ALERT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      opts.log(`  ${summary}`);
      opts.log('  This is not a site change — nothing was modified, nothing was healed.');
      opts.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      opts.log('');
      const evidence = await captureFailureEvidence(
        browser, loopPage, config.url, stateDir, targetKey,
        cause, fetchResult.status, authContext,
      );
      state.lastEvidence = evidence;
      if (evidence.screenshot) opts.log(`  evidence → ${evidence.screenshot}`);
      await runAlerts(opts, state, summary, cycle, config.url || '(rows source)', evidence);
      saveState(opts.statePath, state);
      if (opts.cycles !== undefined && cycle >= opts.cycles) break;
      await sleep(opts.intervalSeconds * 1000);
      continue;
    }

    if (items === null) {
      // The scraper itself failed — a crash is not a site change, and healing
      // it would be guessing about which of the two is broken. Alert instead.
      state.lastStatus = 'red';
      state.alertCount += 1;
      state.lastCheckedAt = checkedAt;
      exitCode = 1;
      opts.log(`[cycle ${cycle}] RED — the scraper source failed to produce rows`);
      opts.log('━━━ ALERT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      opts.log(`  cycle ${cycle}: the scraper command errored or emitted no parseable output`);
      opts.log('  This is a scraper failure, not a site change — check the scraper itself.');
      opts.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      opts.log('');
      state.lastEvidence = reasonOnlyEvidence('scraper source failed to produce rows');
      await runAlerts(opts, state, `cycle ${cycle}: scraper source failed to produce rows`, cycle, config.url || '(rows source)', state.lastEvidence);
      saveState(opts.statePath, state);
      if (opts.cycles !== undefined && cycle >= opts.cycles) break;
      await sleep(opts.intervalSeconds * 1000);
      continue;
    }

    // ---- v2: pagination — when configured, walk every page --------------
    if (items && items.length > 0 && opts.pagination && config.url) {
      opts.log(`  pagination enabled (${opts.pagination.kind}) — walking pages…`);
      try {
        const paged = await extractAllPages(
          loopPage, config.url,
          async () => (await fetchRows()).items ?? [],
          opts.pagination,
        );
        items = paged.items;
        opts.log(`  pagination done — ${items.length} item(s) across ${paged.pagesVisited} page(s)`);
      } catch (err) {
        opts.log(`  pagination failed: ${(err as Error).message}`);
      }
    }

    // ---- v2: visual fallback — when DOM extraction returns empty --------
    if (items && items.length === 0 && config.url) {
      opts.log('  DOM extraction returned 0 items — trying visual grid detection…');
      try {
        const grid = await detectGrid(loopPage);
        if (grid) {
          items = await extractByGrid(loopPage, grid, config.fields);
          opts.log(`  visual extraction: ${items.length} item(s) from a ${grid.rows}×${grid.cols} grid`);
        }
      } catch (err) {
        opts.log(`  visual extraction failed: ${(err as Error).message}`);
      }
    }

    // ---- v2: plugin transforms — post-process the extracted rows --------
    if (items && items.length > 0) {
      try {
        items = await applyTransforms(items, config);
      } catch (err) {
        opts.log(`  plugin transform failed: ${(err as Error).message}`);
      }
    }

    const v = validate(config, items, state.baseline, opts.validator);

    if (v.ok) {
      const prev = state.baseline;
      state.baseline = items;
      rememberLedger(state, config, checkedAt);
      state.lastStatus = 'healthy';
      state.lastCheckedAt = checkedAt;
      exitCode = 0;
      opts.log(
        `[cycle ${cycle}] OK — ${items.length} item(s), shape matches the last good run` +
        (cycle === 1 && items.length ? ' (baseline captured)' : ''),
      );

      // ---- v3: change watching — diff this run against the previous one ----
      // The first cycle only establishes the baseline; after that, every
      // healthy run is diffed and the changes are logged (and, when
      // configured, alerted on thresholds like price drops or restocks).
      if (opts.watch?.enabled !== false && prev.length > 0) {
        const report: ChangeReport = diffChanges(prev, items, config.identityField);
        if (reportHasChanges(report)) {
          const lines = formatChanges(report, config.identityField);
          state.lastChanges = {
            at: checkedAt,
            added: report.added.length,
            removed: report.removed.length,
            changed: report.changed.length,
            lines,
          };
          opts.log('  changes vs the last good run:');
          for (const l of lines) opts.log(l);

          const thresholds = opts.watch?.thresholds;
          const hits = thresholds?.length ? matchesThresholds(report, thresholds) : [];
          if (opts.alerts?.onChange === true && (hits.length || !thresholds?.length)) {
            const summary = hits.length
              ? `cycle ${cycle}: ${hits.map((h) => h.rule).join('; ')} — ${hits.flatMap((h) => h.detail).join('; ')}`
              : `cycle ${cycle}: data changed — ${report.added.length} item(s) added, ${report.removed.length} removed, ${report.changed.length} field change(s)`;
            await runChangeAlerts(opts, state, summary, cycle, config.url || '(rows source)');
          }
        }
      }

      // ---- v2: pipelines — deliver data downstream on every healthy cycle
      if (opts.pipelines && opts.pipelines.length && items.length > 0) {
        runPipelines(opts.pipelines, items as Record<string, unknown>[], opts.log)
          .catch((err) => opts.log(`  pipeline error: ${(err as Error).message}`));
      }
    } else {
      opts.log(`[cycle ${cycle}] RED — ${v.issues.join('; ')}`);

      // Healing needs the live page; a rows-only source without --url cannot
      // repair, only detect and alert.
      if (!config.url) {
        state.lastStatus = 'red';
        state.alertCount += 1;
        state.lastCheckedAt = checkedAt;
        exitCode = 1;
        opts.log('━━━ ALERT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        opts.log(`  cycle ${cycle}: ${v.issues.join('; ')}`);
        opts.log('  No --url was given, so the loop cannot re-measure the page to repair.');
        opts.log('  Add --url <target> to enable self-healing; until then, detection only.');
        opts.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        opts.log('');
        state.lastEvidence = reasonOnlyEvidence(`cycle ${cycle}: ${v.issues.join('; ')}`);
        await runAlerts(opts, state, `cycle ${cycle}: ${v.issues.join('; ')}`, cycle, config.url || '(rows source)', state.lastEvidence);
        saveState(opts.statePath, state);
        if (opts.cycles !== undefined && cycle >= opts.cycles) break;
        await sleep(opts.intervalSeconds * 1000);
        continue;
      }

      // ---- the ledger: remembered configs first --------------------------
      // A site that flip-flops between markup versions (A/B rollouts, cached
      // deploys, rollbacks) hits a previously-proven config before the healer
      // re-derives one from scratch. Same verify-then-ship gate — the memory
      // is what makes a flip cost nothing.
      const remembered = await tryLedger(browser, state, opts.validator, authContext);
      if (remembered) {
        config = remembered.config;
        state.config = remembered.config;
        state.baseline = remembered.data;
        state.lastStatus = 'repaired';
        state.healedAt = checkedAt;
        state.lastCheckedAt = checkedAt;
        exitCode = 0;
        if (opts.writeConfigPath) {
          writeConfig(opts.writeConfigPath, remembered.config);
          opts.log(`  config written → ${opts.writeConfigPath}`);
        }
        opts.log(
          `[cycle ${cycle}] LEDGER HIT — "${remembered.config.items}" + ${remembered.config.fields.map((f) => `${f.name}:"${f.selector}"`).join(', ')}`,
        );
        opts.log('  remembered config re-verified on the live page — shipped without re-healing');
      } else {
        const siteKey = siteOrigin(config.url);
        const result = await heal(browser, config, state.baseline, {
          llm: opts.llm,
          validator: opts.validator,
          memory: state.llmMemory[siteKey],
          verifyTypes: opts.verifyTypes,
          context: authContext,
        });
        if (result.memory) state.llmMemory[siteKey] = result.memory;
        if (result.repaired && result.verified) {
          // The repaired config takes effect immediately — the next cycle must
          // not re-detect the same break against the stale selectors.
          config = result.config;
          state.config = result.config;
          state.baseline = result.verified;
          state.lastStatus = 'repaired';
          state.healedAt = checkedAt;
          state.lastCheckedAt = checkedAt;
          exitCode = 0;
          if (opts.writeConfigPath) {
            writeConfig(opts.writeConfigPath, result.config);
            opts.log(`  config written → ${opts.writeConfigPath}`);
          }
          opts.log(`[cycle ${cycle}] REPAIRED — "${result.config.items}" + ${result.config.fields.map((f) => `${f.name}:"${f.selector}"`).join(', ')}`);
          for (const a of result.attempts) opts.log(`  ${a}`);
          rememberLedger(state, result.config, checkedAt);
        } else {
          state.lastStatus = 'red';
          state.alertCount += 1;
          state.lastCheckedAt = checkedAt;
          exitCode = 1;
          const summary = `cycle ${cycle}: extraction failed against ${config.url} — ${v.issues.join('; ')}; repair not verified, nothing shipped`;
          opts.log('');
          opts.log('━━━ ALERT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          opts.log(`  ${summary}`);
          opts.log('  heal log:');
          for (const a of result.attempts) opts.log(`    ${a}`);
          opts.log('  Nothing was modified. The data is still broken and someone should look.');
          opts.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          opts.log('');
          // The page is right there and broken — keep receipts.
          const evidence = await captureFailureEvidence(
            browser, loopPage, config.url, stateDir, targetKey,
            `cycle ${cycle}: ${v.issues.join('; ')}`, undefined, authContext,
          );
          state.lastEvidence = evidence;
          if (evidence.screenshot) opts.log(`  evidence → ${evidence.screenshot}`);
          await runAlerts(opts, state, summary, cycle, config.url, evidence);
        }
      }
    }

    state.lastCheckedAt = checkedAt;
    saveState(opts.statePath, state);

    if (opts.cycles !== undefined && cycle >= opts.cycles) break;
    await sleep(opts.intervalSeconds * 1000);
  }

  // Release the authenticated session — the loop page first, then whatever
  // the auth mode opened (profile context, login context; attach only
  // disconnects, never closing the user's own browser).
  if (authPage) await authPage.close();
  if (authHandle) await authHandle.close();
  proxyPool?.dispose();
  return exitCode;
}

/** Write the selector config as plain JSON, for any scraper to read back. */
function writeConfig(path: string, config: ScraperConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    items: config.items,
    fields: config.fields,
    identityField: config.identityField,
    minItems: config.minItems,
  }, null, 2));
}
