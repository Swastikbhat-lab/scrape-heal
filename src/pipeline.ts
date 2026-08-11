/**
 * Data output pipelines — where extracted data goes after a healthy cycle.
 *
 * A scraper that only logs to console is a toy. Real pipelines send data
 * downstream: to a database, a webhook, a file, a queue. This module handles
 * the plumbing — format the rows, POST them, write them, retry on failure.
 *
 * Pipelines are configured per-target in scraper.config.json:
 *
 *   "pipelines": [
 *     { "kind": "webhook", "url": "https://my-api.example.com/ingest", "secret": "..." },
 *     { "kind": "file", "path": "./data/products.jsonl" },
 *     { "kind": "postgres", "connection": "postgres://...", "table": "products" },
 *   ]
 *
 * Each pipeline runs after a healthy extraction. Failures are logged and
 * never fatal — a dead webhook must not take the scraper down with it.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ------------------------------------------------------------- types

export type PipelineKind = 'webhook' | 'file' | 'postgres' | 'mysql' | 'webhook-batch';

export interface PipelineDef {
  kind: PipelineKind;
  /** Human label for logging. */
  label?: string;
}

export interface WebhookPipeline extends PipelineDef {
  kind: 'webhook' | 'webhook-batch';
  /** URL to POST to. */
  url: string;
  /** Optional HMAC secret for signing the payload. */
  secret?: string;
  /** Headers to include. */
  headers?: Record<string, string>;
  /** When kind is 'webhook-batch', send all items in one request. */
  batch?: boolean;
}

export interface FilePipeline extends PipelineDef {
  kind: 'file';
  /** File path. `.jsonl` appends; `.json` overwrites. */
  path: string;
}

export interface PostgresPipeline extends PipelineDef {
  kind: 'postgres';
  /** Connection string or env var name. */
  connection: string;
  /** Table to upsert into. */
  table: string;
  /** Column to use for upsert conflict resolution. */
  conflictColumn?: string;
  /** Maximum batch size per INSERT. Default 100. */
  batchSize?: number;
}

export interface MysqlPipeline extends PipelineDef {
  kind: 'mysql';
  connection: string;
  table: string;
  conflictColumn?: string;
  batchSize?: number;
}

export type Pipeline = WebhookPipeline | FilePipeline | PostgresPipeline | MysqlPipeline;

export interface PipelineResult {
  kind: PipelineKind;
  label: string;
  ok: boolean;
  rows: number;
  error?: string;
  durationMs: number;
}

// ------------------------------------------------------------- runner

export async function runPipelines(
  pipelines: Pipeline[],
  rows: Record<string, unknown>[],
  log: (line: string) => void = () => {},
): Promise<PipelineResult[]> {
  if (!pipelines.length || !rows.length) return [];

  const results: PipelineResult[] = [];
  for (const p of pipelines) {
    const label = p.label ?? p.kind;
    const started = Date.now();
    try {
      await runOne(p, rows);
      results.push({ kind: p.kind, label, ok: true, rows: rows.length, durationMs: Date.now() - started });
      log(`pipeline ${label}: ${rows.length} row(s) delivered`);
    } catch (err) {
      results.push({
        kind: p.kind, label, ok: false, rows: 0,
        error: (err as Error).message, durationMs: Date.now() - started,
      });
      log(`pipeline ${label}: FAILED — ${(err as Error).message}`);
    }
  }
  return results;
}

async function runOne(p: Pipeline, rows: Record<string, unknown>[]): Promise<void> {
  switch (p.kind) {
    case 'webhook': {
      for (const row of rows) {
        await postJson(p.url, row, p);
      }
      break;
    }
    case 'webhook-batch': {
      await postJson(p.url, rows, p);
      break;
    }
    case 'file': {
      const isLines = p.path.endsWith('.jsonl') || p.path.endsWith('.ndjson');
      mkdirSync(dirname(p.path), { recursive: true });
      if (isLines) {
        for (const row of rows) appendFileSync(p.path, JSON.stringify(row) + '\n');
      } else {
        writeFileSync(p.path, JSON.stringify(rows, null, 2));
      }
      break;
    }
    case 'postgres':
    case 'mysql': {
      // The database pipeline requires a driver (pg, mysql2). Rather than
      // taking a hard dependency, we require the caller to register a DB
      // runner — see registerDbRunner below.
      if (!dbRunner) throw new Error('No database runner registered — call registerDbRunner() with a pg/mysql2-backed function');
      await dbRunner(p, rows);
      break;
    }
  }
}

// ------------------------------------------------------------- HTTP helper

async function postJson(
  url: string,
  body: unknown,
  opts: { secret?: string; headers?: Record<string, string> },
): Promise<void> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };

  if (opts.secret) {
    // Attach a simple HMAC signature so the receiver can verify authenticity.
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', opts.secret).update(payload).digest('hex');
    headers['x-scrape-heal-signature'] = sig;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  }
}

// ------------------------------------------------------------- DB bridge

export type DbRunner = (pipeline: PostgresPipeline | MysqlPipeline, rows: Record<string, unknown>[]) => Promise<void>;

let dbRunner: DbRunner | null = null;

/** Register a database runner. Called once at startup. */
export function registerDbRunner(fn: DbRunner): void {
  dbRunner = fn;
}

// ------------------------------------------------------------- retry with backoff

export interface RetryOptions {
  /** Max attempts. Default 3. */
  maxAttempts?: number;
  /** Base delay in ms. Default 1000. Doubles each attempt. */
  baseDelayMs?: number;
  /** Max delay in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Whether to add jitter. Default true. */
  jitter?: boolean;
}

/**
 * Retry a function with exponential backoff. Useful for HTTP calls through
 * flaky proxies or to unreliable webhook endpoints.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const addJitter = opts.jitter ?? true;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === maxAttempts) throw lastError;

      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = addJitter ? Math.random() * delay * 0.3 : 0;
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
  }

  throw lastError;
}
