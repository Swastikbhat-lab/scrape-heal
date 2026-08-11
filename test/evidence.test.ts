import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { captureEvidence } from '../src/evidence.js';

const tmp = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-evidence');

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
  rmSync(tmp, { recursive: true, force: true });
});

after(async () => {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('captureEvidence: writes a real PNG + DOM snapshot, returns state-dir-relative paths', async () => {
  const page = await browser.newPage();
  await page.setContent('<html><body><h1>hello</h1></body></html>');

  const ev = await captureEvidence(page, tmp, 'shop-a', 'expected at least 4 item(s), got 0');

  assert.ok(ev.screenshot, 'screenshot path recorded');
  assert.ok(ev.dom, 'dom path recorded');
  assert.ok(ev.screenshot.startsWith('evidence/'), 'paths are relative to the state dir');
  assert.ok(ev.reason.includes('expected at least'), 'the reason is attached');
  assert.equal(ev.status, undefined, 'no status when none was given');

  const png = readFileSync(join(tmp, ev.screenshot!));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'screenshot is a real PNG');

  const dom = readFileSync(join(tmp, ev.dom!), 'utf8');
  assert.ok(dom.includes('<h1>hello</h1>'), 'the DOM snapshot contains the page');
});

test('captureEvidence: records the HTTP status when given', async () => {
  const page = await browser.newPage();
  await page.setContent('<html>blocked</html>');
  const ev = await captureEvidence(page, tmp, 'shop-b', 'blocked', 403);
  assert.equal(ev.status, 403);
});

test('captureEvidence: retention keeps the newest 5 evidence sets per target', async () => {
  const page = await browser.newPage();
  for (let i = 0; i < 7; i++) {
    await page.setContent(`<html><body>run ${i}</body></html>`);
    await captureEvidence(page, tmp, 'shop-c', `reason ${i}`);
  }
  const dir = join(tmp, 'evidence', 'shop-c');
  const stamps = new Set(readdirSync(dir).map((f) => f.split('_')[0]));
  assert.equal(stamps.size, 5, 'only 5 evidence sets survive');

  // The newest one is still there, the oldest two are gone.
  const files = readdirSync(dir);
  assert.ok(files.some((f) => f.includes('_dom.html')));
  assert.equal(files.filter((f) => f.endsWith('.html')).length, 5);
  assert.ok(!files.some((f) => f.startsWith('reason')), 'stamps are timestamps, not reasons');
});
