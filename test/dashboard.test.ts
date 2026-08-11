import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotDir, startDashboard } from '../src/dashboard.js';
import type { WatchState } from '../src/watchdog.js';

const tmp = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-dashboard');

const state = (url: string, over: Partial<WatchState> = {}): WatchState => ({
  config: {
    url,
    items: '.product-card',
    fields: [
      { name: 'name', selector: '.name' },
      { name: 'price', selector: '.price' },
    ],
    identityField: 'name',
    minItems: 4,
  },
  baseline: [
    { name: 'Wireless Mouse', price: '$24.99' },
    { name: 'Mechanical Keyboard', price: '$89.00' },
  ],
  ledger: [],
  llmMemory: {},
  lastStatus: 'healthy',
  lastCheckedAt: '2026-08-11T12:00:00.000Z',
  alertCount: 0,
  ...over,
});

test('snapshotDir: derives one card per state file', () => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  writeFileSync(join(tmp, 'shop-a.json'), JSON.stringify(state('http://127.0.0.1:8123/', {
    lastStatus: 'repaired',
    healedAt: '2026-08-11T11:00:00.000Z',
    alertCount: 2,
    lastAlertAt: '2026-08-11T11:05:00.000Z',
    ledger: [
      { config: { items: '.tile', fields: [{ name: 'name', selector: 'h2' }], identityField: 'name', minItems: 4, url: '' }, verifiedAt: '2026-08-11T11:00:00.000Z', hits: 3 },
    ],
    llmMemory: {
      'http://127.0.0.1:8123': {
        site: 'http://127.0.0.1:8123',
        successes: [
          { at: '2026-08-11T11:00:00.000Z', old: 'a', proposal: { items: '.tile', fields: { name: 'h2' } } },
        ],
        misses: ['a → {\"items\":\".nope\"} — 0 hits'],
      },
    },
  })));
  writeFileSync(join(tmp, 'state.json'), JSON.stringify(state('http://127.0.0.1:9999/')));
  writeFileSync(join(tmp, 'corrupt.json'), '{ not json');

  const snap = snapshotDir(tmp);
  assert.equal(snap.length, 2, 'corrupt files are skipped');
  const [shopA, plain] = snap;
  assert.equal(shopA.name, '127.0.0.1:8123', 'name comes from the target host');
  assert.equal(shopA.lastStatus, 'repaired');
  assert.equal(shopA.itemCount, 2);
  assert.equal(shopA.minItems, 4);
  assert.equal(shopA.alertCount, 2);
  assert.ok(shopA.healedAt && shopA.lastAlertAt, 'timestamps carry through');
  assert.equal(shopA.ledger.length, 1);
  assert.equal(shopA.ledger[0].items, '.tile');
  assert.equal(shopA.ledger[0].hits, 3);
  assert.equal(shopA.learned.length, 1);
  assert.equal(shopA.learned[0].successes, 1);
  assert.equal(shopA.learned[0].misses, 1);
  assert.equal(plain.name, '127.0.0.1:9999');
  assert.equal(plain.ledger.length, 0);
  assert.equal(plain.learned.length, 0);
});

test('snapshotDir: a missing directory is an empty board, not an error', () => {
  assert.deepEqual(snapshotDir(join(tmp, 'does-not-exist')), []);
});

test('dashboard: serves the page, JSON state, and live SSE updates', async () => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const dash = await startDashboard({ stateDir: tmp, port: 0, pollMs: 50 });
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    // the page
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('scrape-heal — live'), 'the page title is present');
    assert.ok(html.includes(tmp), 'the state dir is stamped in');
    assert.ok(html.includes('/events'), 'the page wires itself to the SSE stream');
    // The page is a shell — everything renders client-side, so a broken script
    // would silently show "connecting…" forever. Syntax-check it statically:
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
    assert.ok(script.length > 200, 'the inline script is present');
    assert.doesNotThrow(() => new Function(script), 'the inline script must be valid JS');

    // JSON for scripts
    const js = await (await fetch(base + '/state')).json() as unknown[];
    assert.deepEqual(js, [], 'empty board before any watchdog writes');

    // SSE: connect, then write a state file — an update must arrive
    const es = await fetch(base + '/events');
    const reader = es.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 8_000;
    writeFileSync(join(tmp, 'shop-a.json'), JSON.stringify(state('http://127.0.0.1:8123/', { lastStatus: 'red' })));
    while (!buf.includes('shop-a') && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), 500)),
      ]);
      if (done) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      buf += dec.decode(value, { stream: true });
    }
    assert.ok(buf.includes('event: update'), 'an SSE update event arrived');
    assert.ok(buf.includes('shop-a'), 'the new target is in the pushed snapshot');
    assert.ok(buf.includes('"lastStatus":"red"'), 'the red status made it to the board');

    // /state now reflects the new file too
    const after = await (await fetch(base + '/state')).json() as { name: string }[];
    assert.equal(after.length, 1);
    assert.equal(after[0].name, '127.0.0.1:8123');

    // Regression: a SECOND client connecting while nothing has changed must
    // still get the current board on connect — the dedupe is per-connection.
    const es2 = await fetch(base + '/events');
    const r2 = es2.body!.getReader();
    const dec2 = new TextDecoder();
    let buf2 = '';
    const deadline2 = Date.now() + 5_000;
    while (!buf2.includes('shop-a') && Date.now() < deadline2) {
      const { value, done } = await Promise.race([
        r2.read(),
        new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), 200)),
      ]);
      if (done) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      buf2 += dec2.decode(value, { stream: true });
    }
    assert.ok(buf2.includes('shop-a'), 'a later client gets the initial snapshot even when data is unchanged');
    r2.cancel();
  } finally {
    await dash.close();
  }
});

test('dashboard: falls back to an ephemeral port when the preferred one is busy', async () => {
  const first = await startDashboard({ stateDir: tmp, port: 0, pollMs: 10_000 });
  try {
    const second = await startDashboard({ stateDir: tmp, port: first.port, pollMs: 10_000 });
    try {
      assert.notEqual(second.port, first.port, 'a busy port must not silently double-bind');
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
