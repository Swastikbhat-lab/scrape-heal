/**
 * The live dashboard — a small zero-dependency SSE server over the per-target
 * state files.
 *
 * Every watchdog writes its state to `.scrape-heal/<target>.json`; this server
 * watches that directory, pushes a fresh snapshot the moment anything changes,
 * and renders it as one self-contained page (no build step, no assets):
 *
 *   scrape-heal --dashboard            # open the printed URL
 *
 * Each target card shows the last cycle, the heal history (ledger), and the
 * per-site LLM memory (learned rules) — everything the loop knows, at a glance.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, basename } from 'node:path';
import type { WatchState } from './watchdog.js';

/** One target's dashboard view, derived from its state file. */
export interface TargetSnapshot {
  /** State file name (`.scrape-heal/<name>.json`). */
  file: string;
  /** Human label — the target's host, or the file name when there's no URL. */
  name: string;
  url: string;
  lastStatus: 'healthy' | 'repaired' | 'red';
  lastCheckedAt: string;
  itemCount: number;
  minItems: number;
  alertCount: number;
  healedAt?: string;
  lastAlertAt?: string;
  /** Previously-proven configs — the flip-flop memory, newest first. */
  ledger: { items: string; verifiedAt: string; hits: number }[];
  /** Per-site LLM repair memory — what the loop has learned, at a glance. */
  learned: { site: string; successes: number; misses: number }[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Read every state file in a directory into dashboard snapshots. Corrupt or
 * mid-write files are skipped for that round (the watchdog writes atomically
 * enough that the next poll sees them). A missing directory is an empty board,
 * not an error.
 */
export function snapshotDir(stateDir: string): TargetSnapshot[] {
  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: TargetSnapshot[] = [];
  for (const file of files) {
    let state: WatchState;
    try {
      state = JSON.parse(readFileSync(join(stateDir, file), 'utf8')) as WatchState;
    } catch {
      continue;
    }
    if (!state.config || !state.lastStatus) continue;
    const url = state.config.url ?? '';
    out.push({
      file,
      name: hostOf(url) || basename(file, '.json'),
      url,
      lastStatus: state.lastStatus,
      lastCheckedAt: state.lastCheckedAt,
      itemCount: state.baseline?.length ?? 0,
      minItems: state.config.minItems ?? 0,
      alertCount: state.alertCount ?? 0,
      healedAt: state.healedAt,
      lastAlertAt: state.lastAlertAt,
      ledger: (state.ledger ?? []).map((e) => ({
        items: e.config.items,
        verifiedAt: e.verifiedAt,
        hits: e.hits,
      })),
      learned: Object.entries(state.llmMemory ?? {}).map(([site, m]) => ({
        site,
        successes: m.successes?.length ?? 0,
        misses: m.misses?.length ?? 0,
      })),
    });
  }
  return out;
}

export interface DashboardOptions {
  /** Directory whose `*.json` files are per-target state. */
  stateDir: string;
  /** Preferred port; falls back to an ephemeral port when busy. Default 4321. */
  port?: number;
  /** How often to re-scan the state directory. Default 2000 ms. */
  pollMs?: number;
  log?: (line: string) => void;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

export interface RunningDashboard {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the dashboard: `GET /` serves the page, `GET /events` is the SSE
 * stream (an `update` event whenever any state file changes), `GET /state`
 * returns the snapshot as JSON for scripts. Returns once the port is live.
 */
export async function startDashboard(opts: DashboardOptions): Promise<RunningDashboard> {
  const stateDir = opts.stateDir;
  const pollMs = opts.pollMs ?? 2_000;
  const log = opts.log ?? (() => {});

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      // Dedupe per connection, never globally: every new client must get the
      // current board the moment it connects, even if nothing changed since
      // another client's last send (a stale reconnect would otherwise swallow
      // the initial snapshot and leave the fresh page empty forever).
      let sentFp = '';
      const send = () => {
        const snapshot = snapshotDir(stateDir);
        const fp = JSON.stringify(snapshot);
        if (fp === sentFp) return;
        sentFp = fp;
        res.write(`event: update\ndata: ${JSON.stringify(snapshot)}\n\n`);
      };
      send();
      const timer = setInterval(send, pollMs);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (path === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshotDir(stateDir), null, 2));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE.replace('__STATE_DIR__', stateDir));
  });

  const wanted = opts.port ?? 4321;
  let port: number;
  try {
    port = await listen(server, wanted);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    log(`  port ${wanted} busy — using an ephemeral port instead`);
    port = await listen(server, 0);
  }
  log(`  dashboard live → http://127.0.0.1:${port}/`);
  return {
    server,
    port,
    // A live SSE connection never ends on its own, so close() must force it
    // down — otherwise shutdown would hang waiting for the reader to go away.
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    }),
  };
}

// ----------------------------------------------------------------- page -----
// One self-contained page: dark terminal palette, monospace, live via SSE.
// The state directory is stamped in at serve time.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>scrape-heal — live</title>
<style>
  :root { --bg:#010409; --panel:#161b22; --border:#30363d; --text:#e6edf3;
          --dim:#8b949e; --green:#3fb950; --amber:#d29922; --red:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 18px 24px 6px; border-bottom: 1px solid var(--border); }
  header h1 { margin:0 0 2px; font-size: 17px; letter-spacing: .5px; }
  header h1 .pulse { color: var(--green); }
  header .sub { color: var(--dim); font-size: 12px; }
  main { padding: 18px 24px 40px; max-width: 1100px; }
  #summary { color: var(--dim); margin-bottom: 14px; font-size: 13px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
          margin-bottom: 14px; padding: 14px 16px; }
  .card .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .card .name { font-weight: bold; font-size: 15px; }
  .card .url { color: var(--dim); font-size: 12px; overflow-wrap: anywhere; }
  .pill { padding: 1px 9px; border-radius: 10px; font-size: 11px; font-weight: bold;
          letter-spacing: 1px; text-transform: uppercase; }
  .pill.healthy { color: var(--green); border: 1px solid var(--green); }
  .pill.repaired { color: var(--amber); border: 1px solid var(--amber); }
  .pill.red { color: var(--red); border: 1px solid var(--red); }
  .meta { color: var(--dim); font-size: 12px; }
  .meta b { color: var(--text); font-weight: 600; }
  .section { margin-top: 12px; }
  .section h3 { margin: 0 0 4px; font-size: 11px; letter-spacing: 1.5px;
                text-transform: uppercase; color: var(--dim); }
  .section ul { margin: 0; padding-left: 18px; font-size: 12.5px; }
  .section li { margin: 2px 0; }
  .section .hits { color: var(--green); }
  .section .misses { color: var(--red); }
  .empty { color: var(--dim); text-align: center; padding: 60px 0; font-size: 13px; }
  .empty .big { font-size: 15px; margin-bottom: 6px; }
  #clock { color: var(--dim); font-size: 12px; margin-top: 10px; }
  footer { color: var(--dim); font-size: 11.5px; padding: 0 24px 24px; }
</style>
</head>
<body>
<header>
  <h1><span class="pulse">●</span> scrape-heal — live</h1>
  <div class="sub">every target's last cycle, heal history, and learned rules · state dir: __STATE_DIR__</div>
</header>
<main>
  <div id="summary">connecting…</div>
  <div id="board"></div>
  <div id="clock"></div>
</main>
<footer>press Ctrl+C in the scrape-heal terminal to stop · /state returns this as JSON for scripts</footer>
<script>
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rel = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };
  const summary = (t) => {
    const n = t.length;
    const ok = t.filter((x) => x.lastStatus === 'healthy').length;
    const healed = t.filter((x) => x.lastStatus === 'repaired').length;
    const red = t.filter((x) => x.lastStatus === 'red').length;
    return n + ' target(s) · ' + ok + ' healthy · ' + healed + ' repaired · ' + red + ' red';
  };
  const card = (t) => \`
    <div class="card">
      <div class="row">
        <span class="name">\${esc(t.name)}</span>
        <span class="pill \${t.lastStatus}">\${t.lastStatus}</span>
        <span class="meta">checked <b>\${rel(t.lastCheckedAt)}</b> · \${t.itemCount}/\${t.minItems} items</span>
        <span class="meta">alerts <b>\${t.alertCount}</b>\${t.lastAlertAt ? ' · last ' + rel(t.lastAlertAt) : ''}</span>
      </div>
      \${t.url ? '<div class="url">' + esc(t.url) + '</div>' : ''}
      \${t.healedAt ? '<div class="meta">last healed <b>' + rel(t.healedAt) + '</b></div>' : ''}
      \${t.ledger.length ? \`
      <div class="section"><h3>heal history (ledger)</h3><ul>
        \${t.ledger.map((e) => '<li>items "' + esc(e.items) + '" — proven ' + rel(e.verifiedAt) +
          ' · <span class="hits">' + e.hits + ' hit' + (e.hits === 1 ? '' : 's') + '</span></li>').join('')}
      </ul></div>\` : ''}
      \${t.learned.length ? \`
      <div class="section"><h3>learned rules (llm memory)</h3><ul>
        \${t.learned.map((m) => '<li>' + esc(m.site) + ' — <span class="hits">' + m.successes +
          ' repair' + (m.successes === 1 ? '' : 's') + '</span> · <span class="misses">' + m.misses +
          ' miss' + (m.misses === 1 ? '' : 'es') + '</span></li>').join('')}
      </ul></div>\` : ''}
    </div>\`;
  let targets = [];
  const render = () => {
    const board = document.getElementById('board');
    document.getElementById('summary').textContent = summary(targets);
    if (!targets.length) {
      board.innerHTML = \`<div class="empty"><div class="big">no state files yet</div>
        start a watchdog — e.g. scrape-heal --watch --demo — and its targets appear here.</div>\`;
    } else {
      board.innerHTML = targets.map(card).join('');
    }
    document.getElementById('clock').textContent =
      'updated ' + rel(new Date().toISOString()) + ' · auto-refreshes';
  };
  const es = new EventSource('/events');
  es.addEventListener('update', (e) => { targets = JSON.parse(e.data); render(); });
  es.onerror = () => { /* EventSource reconnects on its own */ };
  setInterval(render, 2000); // keep the relative times fresh
</script>
</body>
</html>
`;
