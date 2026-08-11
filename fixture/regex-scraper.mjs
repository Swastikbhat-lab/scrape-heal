#!/usr/bin/env node
/**
 * The deliberately dumb scraper.
 *
 * Plain `fetch` + regex. No browser, no DOM parser, no selectors engine —
 * this is the scraper that "works until the site redesigns and then quietly
 * returns nothing". It exists to prove that scrape-heal's loop does not care
 * what produced the rows: only the *output* matters.
 *
 * Reads its selector config from a JSON file (the exact shape scrape-heal
 * writes with --write-config), prints rows as a JSON array on stdout.
 *
 *   node fixture/regex-scraper.mjs --url <url> --config <path>
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='));
const configArg = args.find((a) => a.startsWith('--config='));
if (!urlArg || !configArg) {
  console.error('usage: node fixture/regex-scraper.mjs --url <url> --config <path>');
  process.exit(2);
}
const url = urlArg.slice('--url='.length);
const config = JSON.parse(readFileSync(configArg.slice('--config='.length), 'utf8'));

const html = await fetch(url).then((r) => r.text());

const classOf = (sel) => (sel.match(/\.([\w-]+)/) || [])[1];
const tagOf = (sel) => (sel.match(/^([a-z][\w-]*)/) || [])[1] ?? '[a-z][\\w-]*';

const containerClass = classOf(config.items);
const containerRe = new RegExp(
  `<(${tagOf(config.items)})[^>]*class="[^"]*\\b${containerClass}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`,
  'g',
);

const rows = [];
for (const m of html.matchAll(containerRe)) {
  const inner = m[2];
  const row = {};
  for (const f of config.fields) {
    const c = classOf(f.selector);
    const re = new RegExp(
      `<([a-z][\\w-]*)[^>]*class="[^"]*\\b${c}\\b[^"]*"[^>]*>\\s*([^<]*?)\\s*<`,
    );
    const fm = inner.match(re);
    row[f.name] = fm ? fm[2].trim() : '';
  }
  rows.push(row);
}

process.stdout.write(`${JSON.stringify(rows)}\n`);
