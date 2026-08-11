/**
 * REST API server — run scrape-heal as an HTTP service.
 *
 * Instead of the watchdog loop owning the process, this server exposes the
 * loop as endpoints. A scheduler (cron, a cloud function, a manual curl) hits
 * an endpoint; the server runs one cycle and returns the result. State lives
 * in the same per-target JSON files the dashboard reads, so both can run
 * simultaneously.
 *
 *   npm run api                              # start on :4200
 *   curl http://localhost:4200/targets       # list targets
 *   curl -X POST http://localhost:4200/run   # run one cycle on all targets
 *   curl -X POST http://localhost:4200/run/example.com  # run one target
 *
 * Endpoints:
 *   GET  /health            — liveness check
 *   GET  /targets           — list configured targets and their last status
 *   GET  /targets/:id       — one target's full state
 *   POST /run               — run one cycle on every target, return results
 *   POST /run/:id           — run one cycle on one target
 *   GET  /state             — full state dump (for scripting)
 *   GET  /events            — SSE stream of cycle results (real-time)
 */

import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { ScraperConfig } from './scraper.js';
import { runWatchdog, loadState, type WatchState } from './watchdog.js';
import { snapshotDir, type TargetSnapshot } from './dashboard.js';
import { commandRows, fileRows, type RowFetch } from './source.js';
import type { LLMOptions } from './llm.js';
import type { AlertChannel } from './alert.js';
import type { Validator } from './scraper.js';
import {
  CONFIG_FILENAME, readConfigFile, mergeTargetConfigs,
  type WatchFileConfig,
} from './config.js';

// ------------------------------------------------------------- types

export interface ApiConfig {
  /** Directory with per-target state files. */
  stateDir: string;
  /** Watchdog interval for per-cycle runs (seconds). */
  intervalSeconds?: number;
  /** Port to listen on. Default 4200. */
  port?: number;
  /** LLM options passed through to the watchdog. */
  llm?: LLMOptions;
  /** Alert channels (webhooks pinged on red cycles). */
  alerts?: AlertChannel;
}

interface TargetInfo {
  id: string;
  name: string;
  url: string;
  snapshot: TargetSnapshot | null;
}

// ------------------------------------------------------------- server

export async function startApi(
  config: ApiConfig,
  log: (line: string) => void = () => {},
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const stateDir = resolve(config.stateDir);
  const port = config.port ?? 4200;
  const llm = config.llm;
  const alerts = config.alerts;

  // Shared browser — launched once and reused across cycles.
  let browser: Browser | null = null;
  const getBrowser = async (): Promise<Browser> => {
    if (!browser) browser = await chromium.launch();
    return browser;
  };

  // Build the target registry from config file + state files.
  const resolveTargets = (): TargetInfo[] => {
    const configPath = resolve(CONFIG_FILENAME);
    let cfg: WatchFileConfig = {};
    if (existsSync(configPath)) {
      try { cfg = readConfigFile(configPath); } catch { /* ignore */ }
    }
    const snapshots = snapshotDir(stateDir);

    if (cfg.targets?.length) {
      return cfg.targets.map((t, i) => {
        const url = t.url ?? '';
        const label = url ? hostOf(url) : `target-${i + 1}`;
        const snap = snapshots.find((s) =>
          s.file === `${label}.json` || s.name === label || s.url === url);
        return { id: label, name: label, url, snapshot: snap ?? null };
      });
    }

    // Single target from state.
    if (snapshots.length) {
      return snapshots.map((s) => ({
        id: s.file.replace('.json', ''),
        name: s.name,
        url: s.url,
        snapshot: s,
      }));
    }

    return [];
  };

  // Run one watchdog cycle and return what happened.
  const runCycle = async (
    target: TargetInfo,
    logLine: (line: string) => void,
  ): Promise<{ ok: boolean; status: string; log: string[] }> => {
    const lines: string[] = [];
    const logFn = (line: string) => { lines.push(line); logLine(line); };

    const br = await getBrowser();
    const page = await br.newPage();
    const statePath = resolve(stateDir, `${target.id}.json`);

    // Build config from file + state.
    let scraperConfig: ScraperConfig = {
      url: target.url,
      items: '.product-card',
      fields: [
        { name: 'name', selector: '.name' },
        { name: 'price', selector: '.price' },
      ],
      identityField: 'name',
      minItems: 1,
    };

    // Load persisted config if available.
    if (existsSync(statePath)) {
      try {
        const st = JSON.parse(readFileSync(statePath, 'utf8')) as WatchState;
        if (st.config) scraperConfig = st.config;
      } catch { /* use defaults */ }
    }

    const exitCode = await runWatchdog(br, page, {
      intervalSeconds: config.intervalSeconds ?? 5,
      cycles: 1,
      statePath,
      llm,
      alerts,
      log: logFn,
    }, scraperConfig);

    await page.close();

    return {
      ok: exitCode === 0,
      status: exitCode === 0 ? 'healthy' : 'red',
      log: lines,
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
    };

    try {
      // ---- GET /health
      if (path === '/health') {
        json({ status: 'ok', uptime: process.uptime() });
        return;
      }

      // ---- GET /targets
      if (path === '/targets') {
        json(resolveTargets());
        return;
      }

      // ---- GET /targets/:id
      const targetMatch = path.match(/^\/targets\/(.+)$/);
      if (targetMatch && req.method === 'GET') {
        const targets = resolveTargets();
        const t = targets.find((x) => x.id === targetMatch[1]);
        if (!t) { json({ error: 'not found' }, 404); return; }

        const statePath = resolve(stateDir, `${t.id}.json`);
        if (existsSync(statePath)) {
          json(JSON.parse(readFileSync(statePath, 'utf8')));
        } else {
          json({ id: t.id, status: 'no state yet' });
        }
        return;
      }

      // ---- POST /run
      if (path === '/run' && req.method === 'POST') {
        const targets = resolveTargets();
        if (!targets.length) {
          json({ error: 'no targets configured — create scraper.config.json or add state files' }, 400);
          return;
        }

        log(`Running cycle on ${targets.length} target(s)...`);
        const results: Record<string, unknown>[] = [];

        for (const t of targets) {
          const r = await runCycle(t, (l) => log(`[${t.id}] ${l}`));
          results.push({ id: t.id, ...r });
        }

        json({ results });
        return;
      }

      // ---- POST /run/:id
      const runMatch = path.match(/^\/run\/(.+)$/);
      if (runMatch && req.method === 'POST') {
        const targets = resolveTargets();
        const t = targets.find((x) => x.id === runMatch[1]);
        if (!t) { json({ error: 'target not found' }, 404); return; }

        const r = await runCycle(t, (l) => log(`[${t.id}] ${l}`));
        json({ id: t.id, ...r });
        return;
      }

      // ---- GET /state
      if (path === '/state') {
        const snapshots = snapshotDir(stateDir);
        json(snapshots);
        return;
      }

      // ---- GET /events (SSE)
      if (path === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        let lastFingerprint = '';
        const send = () => {
          const snapshot = snapshotDir(stateDir);
          const fp = JSON.stringify(snapshot);
          if (fp === lastFingerprint) return;
          lastFingerprint = fp;
          res.write(`event: update\ndata: ${JSON.stringify(snapshot)}\n\n`);
        };
        send();
        const timer = setInterval(send, 2000);
        req.on('close', () => clearInterval(timer));
        return;
      }

      // ---- 404
      json({ error: 'not found', endpoints: [
        'GET /health', 'GET /targets', 'GET /targets/:id',
        'POST /run', 'POST /run/:id', 'GET /state', 'GET /events',
      ]}, 404);
    } catch (err) {
      json({ error: (err as Error).message }, 500);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      log(`scrape-heal API → http://127.0.0.1:${actual}/`);
      log(`  GET /health  ·  GET /targets  ·  POST /run`);
      resolvePromise({
        server,
        port: actual,
        close: async () => {
          if (browser) await browser.close();
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}
