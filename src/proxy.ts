/**
 * Proxy rotation engine.
 *
 * When a site blocks you, having one IP address means you're done. This module
 * manages a pool of proxies, rotating them across requests. A proxy that returns
 * a block signal (HTTP 403, captcha page, Cloudflare challenge) is cooled down
 * and retried later. Proxies are evaluated on every use, so the pool self-heals
 * as dead proxies are removed and cooled proxies return.
 *
 * Supports:
 *   - Static proxy list (http://user:pass@host:port)
 *   - Proxy provider APIs (auto-refresh the pool)
 *   - Per-proxy cooldown with backoff
 *   - Block detection via status codes + page content signatures
 *   - Proxy scoring (success rate, latency) for smart selection
 *
 *   const pool = new ProxyPool({ proxies: ['http://p1:8080', 'http://p2:8080'] });
 *   const proxy = pool.next(); // round-robin, skipping cooled-down proxies
 *   // ... use proxy in Playwright launch ...
 *   pool.record(proxy, { ok: true, ms: 234 });
 */

import { randomUUID } from 'node:crypto';

// ------------------------------------------------------------- proxy pool

export interface ProxyEntry {
  /** The proxy URL Playwright understands, e.g. http://user:pass@host:port */
  url: string;
  /** Unique id for tracking this proxy across rotations */
  id: string;
  /** Consecutive failures — drives cooldown duration */
  failures: number;
  /** When this proxy was last cooled down (ISO), or null */
  cooledUntil: string | null;
  /** Total requests through this proxy */
  total: number;
  /** Successful requests */
  ok: number;
  /** Rolling average latency in ms */
  avgMs: number;
  /** When this proxy was added to the pool */
  addedAt: string;
}

export interface ProxyPoolOptions {
  /** Static proxy URLs */
  proxies?: string[];
  /** Minimum number of healthy proxies before alerting */
  minHealthy?: number;
  /** Base cooldown in seconds (doubles per consecutive failure) */
  cooldownBaseSeconds?: number;
  /** Max cooldown in seconds */
  cooldownMaxSeconds?: number;
  /** Provider URL that returns a JSON array of proxy URLs (auto-refresh) */
  providerUrl?: string;
  /** Refresh provider pool every N seconds */
  providerRefreshSeconds?: number;
}

/** Content signatures that indicate a block page rather than real content. */
const BLOCK_SIGNATURES = [
  'cf-browser-verification',
  'cf-challenge-running',
  'Just a moment',
  'Checking your browser',
  'DDoS protection',
  'captcha',
  'Access Denied',
  '403 Forbidden',
];

export class ProxyPool {
  private entries: ProxyEntry[] = [];
  private cursor = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly minHealthy: number;
  readonly cooldownBase: number;
  readonly cooldownMax: number;

  constructor(private opts: ProxyPoolOptions = {}) {
    this.minHealthy = opts.minHealthy ?? 1;
    this.cooldownBase = opts.cooldownBaseSeconds ?? 30;
    this.cooldownMax = opts.cooldownMaxSeconds ?? 300;

    if (opts.proxies) this.add(opts.proxies);

    if (opts.providerUrl) {
      this.refreshFromProvider(opts.providerUrl);
      this.refreshTimer = setInterval(
        () => this.refreshFromProvider(opts.providerUrl!),
        (opts.providerRefreshSeconds ?? 120) * 1000,
      );
    }
  }

  /** Number of proxies in the pool (including cooled ones). */
  get size(): number { return this.entries.length; }

  /** Number of proxies currently available (not cooled). */
  get available(): number {
    return this.entries.filter((e) => !this.isCooled(e)).length;
  }

  /** True when the pool has fewer healthy proxies than minHealthy. */
  get degraded(): boolean {
    return this.available < this.minHealthy;
  }

  /** All proxy entries — for inspection and serialisation. */
  get all(): Readonly<ProxyEntry[]> { return this.entries; }

  /**
   * Add proxies to the pool. Duplicates (by URL) are silently skipped.
   */
  add(urls: string[]): void {
    const seen = new Set(this.entries.map((e) => e.url));
    const now = new Date().toISOString();
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      this.entries.push({
        url, id: randomUUID().slice(0, 8),
        failures: 0, cooledUntil: null,
        total: 0, ok: 0, avgMs: 0,
        addedAt: now,
      });
    }
  }

  /**
   * Return the next healthy proxy. When all are cooled, returns the one whose
   * cooldown expires soonest (the caller can decide to wait or fail).
   */
  next(): ProxyEntry | null {
    if (!this.entries.length) return null;

    const start = this.cursor;
    for (let i = 0; i < this.entries.length; i++) {
      this.cursor = (this.cursor + 1) % this.entries.length;
      const entry = this.entries[this.cursor];
      if (!this.isCooled(entry)) return entry;
    }

    // All cooled — return the one whose cooldown expires soonest.
    const soonest = this.entries.reduce((best, e) => {
      const a = e.cooledUntil ? Date.parse(e.cooledUntil) : 0;
      const b = best?.cooledUntil ? Date.parse(best.cooledUntil) : 0;
      return a < b ? e : best;
    });
    return soonest;
  }

  /**
   * Record the outcome of a proxy request. On success the failure counter
   * resets. On failure the proxy goes into cooldown with exponential backoff.
   */
  record(entry: ProxyEntry, result: { ok: boolean; ms: number; status?: number; bodySample?: string }): void {
    const e = this.entries.find((x) => x.id === entry.id);
    if (!e) return;

    e.total++;
    if (result.ok) {
      e.ok++;
      e.failures = 0;
      e.cooledUntil = null;
      // Exponential moving average of latency
      const alpha = 0.2;
      e.avgMs = e.avgMs === 0 ? result.ms : alpha * result.ms + (1 - alpha) * e.avgMs;
    } else {
      e.failures++;
      const delay = Math.min(
        this.cooldownBase * Math.pow(2, e.failures - 1),
        this.cooldownMax,
      );
      e.cooledUntil = new Date(Date.now() + delay * 1000).toISOString();
    }
  }

  /**
   * Check whether the HTTP response looks like a block page.
   * Returns true when the request should be treated as an anti-bot block.
   */
  static isBlocked(status: number, bodyText?: string): boolean {
    if (status === 403 || status === 429 || status === 503) return true;
    if (!bodyText) return false;
    const lower = bodyText.toLowerCase();
    return BLOCK_SIGNATURES.some((sig) => lower.includes(sig.toLowerCase()));
  }

  /**
   * Remove a proxy from the pool permanently.
   */
  remove(entry: ProxyEntry): void {
    this.entries = this.entries.filter((e) => e.id !== entry.id);
  }

  /** Stop the provider refresh timer. Call on shutdown. */
  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  // ---- internals

  private isCooled(e: ProxyEntry): boolean {
    if (!e.cooledUntil) return false;
    return Date.now() < Date.parse(e.cooledUntil);
  }

  private async refreshFromProvider(url: string): Promise<void> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const list = (await res.json()) as string[];
      if (Array.isArray(list) && list.length) this.add(list);
    } catch {
      // Provider unreachable — keep the current pool.
    }
  }
}

// ------------------------------------------------------------- Playwright integration

import type { LaunchOptions } from 'playwright';

/**
 * Turn a proxy URL into Playwright launch options.
 *
 *   const entry = pool.next();
 *   const browser = await chromium.launch({
 *     ...proxyLaunchOptions(entry.url),
 *   });
 */
export function proxyLaunchOptions(proxyUrl: string): LaunchOptions['proxy'] {
  try {
    const u = new URL(proxyUrl);
    const out: LaunchOptions['proxy'] = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: proxyUrl };
  }
}
