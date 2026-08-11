import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string) => resolve(root, 'fixture', name);
const dir = resolve(root, '.scrape-heal', 'test-repair');
const cfgPath = resolve(dir, 'scraper.config.json');
const baselinePath = resolve(dir, 'baseline.json');

/** One local server whose served file can be swapped between tests. */
function startSite() {
  const current = { file: fixture('site-v1.html') };
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(current.file));
  });
  return new Promise<{ url: string; serve: (name: string) => void; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({
        url: `http://127.0.0.1:${port}/`,
        serve: (name) => { current.file = fixture(name); },
        close: () => server.close(),
      });
    });
  });
}

/** Run the real CLI in a subprocess — the exact seam the Scrapy middleware uses. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('close', (code) => ok({ code: code ?? -1, stdout, stderr }));
  });
}

const baseline = [
  { name: 'Wireless Mouse', price: '$24.99' },
  { name: 'Mechanical Keyboard', price: '$89.00' },
  { name: 'USB-C Hub', price: '$39.50' },
  { name: '4K Monitor', price: '$299.00' },
];

function writeConfig(url: string): void {
  writeFileSync(cfgPath, JSON.stringify({
    url,
    items: '.product-card',
    fields: { name: '.name', price: '.price' },
    identityField: 'name',
    minItems: 4,
  }, null, 2));
}

before(() => mkdirSync(dir, { recursive: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

test('repair CLI: heals a redesign against the last good rows and rewrites the config', async () => {
  const site = await startSite();
  try {
    writeConfig(site.url);
    writeFileSync(baselinePath, JSON.stringify(baseline));

    site.serve('site-v2.html'); // the redesign: renamed classes, same data
    const { code, stdout, stderr } = await runCli(['--repair', '--config', cfgPath, '--rows', baselinePath]);
    assert.equal(code, 0, `stderr:\n${stderr}\nstdout:\n${stdout}`);
    assert.match(stdout, /repaired/);

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.items, '.item');
    assert.ok(cfg.fields.name.includes('title'), JSON.stringify(cfg.fields));
    assert.ok(cfg.fields.price.includes('amount'), JSON.stringify(cfg.fields));
    // Only the selectors changed — the rest of the config survived.
    assert.equal(cfg.url, site.url);
    assert.equal(cfg.identityField, 'name');
    assert.equal(cfg.minItems, 4);
  } finally {
    site.close();
  }
});

test('repair CLI: refuses when nothing can be verified — config untouched', async () => {
  const site = await startSite();
  try {
    writeConfig(site.url);
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const before = readFileSync(cfgPath, 'utf8');

    site.serve('site-v3.html'); // values changed, no LLM configured — no text anchor survives
    const { code, stderr } = await runCli(['--repair', '--config', cfgPath, '--rows', baselinePath]);
    assert.equal(code, 1);
    assert.match(stderr, /repair failed/);
    assert.match(stderr, /nothing shipped/);
    assert.equal(readFileSync(cfgPath, 'utf8'), before, 'nothing may be modified');
  } finally {
    site.close();
  }
});
