import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { Browser, Page } from 'playwright';
import type { ScraperConfig, ExtractedItem, Validator } from './scraper.js';
import { extract, validate } from './scraper.js';
import { heal, siteOrigin } from './heal.js';
import type { LLMOptions, SiteLLMMemory } from './llm.js';
import { sendAlert, type AlertChannel } from './alert.js';
import { playwrightRows, type RowFetch } from './source.js';

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

function runAlertHook(command: string | undefined, summary: string): void {
  if (!command) return;
  const child = spawn(command, { shell: true, env: { ...process.env, SCRAPE_HEAL_ALERT: summary } });
  child.on('error', (err) => console.error(`  alert hook failed: ${err.message}`));
}

const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;

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
async function runAlerts(
  opts: { onAlert?: string; alerts?: AlertChannel; log: (line: string) => void },
  state: WatchState,
  summary: string,
  cycle: number,
  target: string,
): Promise<void> {
  const cooldown = opts.alerts?.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES;
  const now = new Date().toISOString();
  if (alertThrottled(state.lastAlertAt, cooldown, now)) {
    opts.log(`  alert throttled — already alerted for this target within the last ${cooldown} min; next alert once the cooldown clears`);
    return;
  }
  state.lastAlertAt = now;
  runAlertHook(opts.onAlert, summary);
  if (!opts.alerts) return;
  try {
    await sendAlert(opts.alerts, { target, cycle, summary, at: now });
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
): Promise<{ config: ScraperConfig; data: ExtractedItem[] } | null> {
  const currentSig = configSignature(state.config);
  for (const entry of state.ledger) {
    if (configSignature(entry.config) === currentSig) continue; // this one just failed
    const page = await browser.newPage();
    try {
      const items = await extract(entry.config, page);
      const v = validate(entry.config, items, state.baseline, validator);
      if (v.ok) {
        entry.hits += 1;
        return { config: entry.config, data: items };
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
  const fetchRows = opts.fetchRows ?? playwrightRows(page, () => config);

  let exitCode = 0;
  let cycle = 0;
  while (true) {
    cycle++;
    const checkedAt = new Date().toISOString();

    const items = await fetchRows();
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
      await runAlerts(opts, state, `cycle ${cycle}: scraper source failed to produce rows`, cycle, config.url || '(rows source)');
      saveState(opts.statePath, state);
      if (opts.cycles !== undefined && cycle >= opts.cycles) break;
      await sleep(opts.intervalSeconds * 1000);
      continue;
    }

    const v = validate(config, items, state.baseline, opts.validator);

    if (v.ok) {
      state.baseline = items;
      rememberLedger(state, config, checkedAt);
      state.lastStatus = 'healthy';
      state.lastCheckedAt = checkedAt;
      exitCode = 0;
      opts.log(
        `[cycle ${cycle}] OK — ${items.length} item(s), shape matches the last good run` +
        (cycle === 1 && items.length ? ' (baseline captured)' : ''),
      );
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
        await runAlerts(opts, state, `cycle ${cycle}: ${v.issues.join('; ')}`, cycle, config.url || '(rows source)');
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
      const remembered = await tryLedger(browser, state, opts.validator);
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
          await runAlerts(opts, state, summary, cycle, config.url);
        }
      }
    }

    state.lastCheckedAt = checkedAt;
    saveState(opts.statePath, state);

    if (opts.cycles !== undefined && cycle >= opts.cycles) break;
    await sleep(opts.intervalSeconds * 1000);
  }

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
