<div align="center">

# 🩹 scrape-heal

**Your scraper breaks when the site redesigns. This fixes itself — or tells you exactly what broke.**

Scrapers have one job, and it falls apart in the most boring way possible: the site renames a class,
moves a `<div>`, and suddenly your 3am cron job extracts *nothing*. Not an error, not a warning —
just an empty spreadsheet you notice a week later.

`scrape-heal` remembers what your data looked like, notices when it stops looking like that, and
repairs its own selectors — **only after proving the repair works on the live page.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/scrape-heal?logo=npm&logoColor=white)](https://www.npmjs.com/package/scrape-heal)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](#)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#)
[![Playwright](https://img.shields.io/badge/powered%20by-Playwright-2f9e44?logo=playwright&logoColor=white)](#)
[![CI](https://github.com/Swastikbhat-lab/scrape-heal/actions/workflows/ci.yml/badge.svg)](https://github.com/Swastikbhat-lab/scrape-heal/actions/workflows/ci.yml)

</div>

## The loop

```mermaid
flowchart LR
    A["extract rows"] --> B{"validate vs the<br/>last good run"}
    B -->|"same shape ✓"| C["refresh baseline"]
    B -->|"broken ✗"| D["hunt the known values —<br/>or ask the model<br/>(when values changed)"]
    D --> E["verify: re-extract<br/>must match"]
    E -->|"pass"| F[" ship the repair"]
    E -->|"fail"| G[" alert — change nothing"]
```

Three moving parts, each boring on purpose:

1. **Detect** — every run validates against a schema: enough items, no empty fields, every known
   value still present. A selector that returns *wrong-shaped* data is treated as broken, because it is.
2. **Heal** — the last good run *is* the ground truth. The healer looks at the live page for elements
   that still contain those exact values and derives new selectors from them. No guessing, no regex
   archaeology: it knows the products are called *"Wireless Mouse"* and *"$24.99"*, so it finds them.
3. **Verify — the load-bearing step** — the candidate config is re-run against the live page, and the
   repair ships only if the schema validates, every known item is still there, **and the values still
   look like the same kind of data** (a `price` field that suddenly yields prose is a wrong binding,
   not a repair). A healer that doesn't verify is just a more confident way to break your data.

## What's in the box

| Capability | What it does | Where |
|---|---|---|
| **The loop** | detect → heal → verify → settle, on a cadence | watchdog |
| **Any scraper** | watch JSON / JSONL / CSV rows from a command or file | `rowsFrom` / `rowsFile` |
| **LLM repair** | when even the values changed — model proposes, browser verifies | `llm` |
| **Value-type verification** | a repair whose values stop looking like themselves is refused (a `price` field yielding prose never ships) | `fieldTypes` / `verifyValueTypes` |
| **Selector ledger** | flip-flopping sites heal once, then answer from memory (`LEDGER HIT`) | state |
| **Pluggable validators** | your schema replaces the built-in shape checks | `validator` |
| **Fleet** | one config file, many targets, each its own watchdog | `targets` |
| **Alerting** | Slack / Discord / webhook, throttled per target | `alerts` |
| **Dashboard** | zero-dependency live board over the state files | `--dashboard` |
| **Pagination** | next-link, load-more, infinite-scroll, or `{page}` URL patterns | `pagination` |
| **Proxy rotation** | scored pool with cooldown, backoff, and block detection | `proxy` |
| **Auth** | pages behind a login — session held across cycles, scraped and healed like any other | `auth` |
| **Pipelines** | send healthy rows downstream: webhook, file, Postgres, MySQL | `pipelines` |
| **Plugins** | extend the loop: extractors, site-specific healers, transforms | `pluginsDir` |
| **Visual extraction** | reads a redesigned grid straight off the pixels (OCR seam included) | visual |
| **REST API** | run the loop as an HTTP service — cron-friendly, SSE events | `startApi` |
| **Change watching** | diff every healthy cycle — price drops, restocks, new items — alert on thresholds | `watch` |
| **Failure classification** | retry 5xx/timeouts with backoff, rotate proxies on blocks, heal only real breakage | built-in |
| **Evidence on red** | screenshot + DOM snapshot + HTTP status per failed cycle, on the board and in alerts | built-in |
| **Library API** | the whole loop as functions — embed it in your own scheduler | `import 'scrape-heal'` |
| **Drop-in adapters** | call the loop from Scrapy, Crawlee, or plain Playwright — no migration | `integrations/` |

## See it happen

The whole story in 24 seconds — healthy run, silent redesign, breakage detected, selectors
healed, verified on the live page:

<div align="center">
  <img src="docs/demo.gif" alt="demo: healthy run, silent redesign, breakage detected, selectors repaired and verified" width="680">
</div>

On a cadence it becomes a watchdog — cycle after cycle, a red run repairs itself or alerts:

<div align="center">
  <img src="docs/watchdog.gif" alt="watchdog: OK → OK → RED → REPAIRED → OK, cycle after cycle" width="680">
</div>

## Quickstart

Install from npm — no clone needed (Node ≥ 20):

```bash
npm install -g scrape-heal
npx playwright install chromium          # once — the loop drives a real browser
scrape-heal --demo --mutate 6 --interval 5 --cycles 8   # watch it break and heal itself
```

Then point it at something real:

```bash
scrape-heal --init        # writes scraper.config.json — every option, commented
# ... edit url, items, fields ...
scrape-heal               # reads scraper.config.json automatically, zero flags
```

Running from a clone instead? `npm install`, `npx playwright install chromium`,
`npm run demo`, `npm test` — every `npm run *` script maps 1:1 to a `scrape-heal`
command.

## Plug and play

One config file, one command. Every key optional; CLI flags override the file when both are present:

```jsonc
{
  "url": "https://example.com/products",   // what to watch
  "items": ".product-card",                // repeating item container
  "fields": { "name": ".name", "price": ".price" },
  "identityField": "name",                 // identifies one item uniquely
  "minItems": 4,                           // below this = broken
  "intervalSeconds": 300,                  // watchdog cadence

  "rowsFrom": null,                        // or: run any scraper, read JSON/CSV rows
  "rowsFile": null,                        // or: watch a file your scraper already writes
  "writeConfig": "scraper.config.json",    // repaired selectors, written back here
  "onAlert": null,                         // command run on an unhealable red cycle
  "statePath": ".scrape-heal/state.json",

  "llm": { "apiKey": null, "model": "gpt-4o-mini", "baseUrl": null, "maxAttempts": 3 },
  "validator": null,                       // path to a JS file exporting your schema check
  "alerts": { "slack": null, "discord": null, "webhook": null, "cooldownMinutes": 60 },
  "dashboard": { "port": 4321, "stateDir": ".scrape-heal" },

  // ---- v2 ----
  "pagination": { "kind": "next-link", "selector": ".pagination .next", "maxPages": 20 },
  "proxy": { "proxies": null, "providerUrl": null, "cooldownBaseSeconds": 30 },
  "pipelines": [ { "kind": "file", "path": "./data/products.jsonl" } ],
  "auth": { "kind": "attach", "cdp": "http://127.0.0.1:9222" },
  "pluginsDir": "./scrape-heal-plugins",

  // ---- v3 ----
  "watch": {
    "enabled": true,
    "thresholds": [
      { "field": "price", "dropPercent": 5 },
      { "field": "stock", "changedTo": "in stock" }
    ]
  },
  "alerts": { "onChange": true, "changeCooldownMinutes": 60 },

  "targets": null                          // or: a fleet — see "Watch a fleet" below
}
```

## Watchdog mode

A single run is a snapshot. On a cadence it becomes a watchdog: **the moment a run goes red, it
either repairs itself or alerts — notifies you the same day, not the day after.**

Each cycle: **extract → validate against the last good run.** Healthy cycles refresh the baseline (so
legit new content is tracked, not treated as breakage). A red cycle is handed to the healer — a
verified repair is shipped *and takes effect immediately*; when nothing can be verified, it says so
loudly and nothing is modified:

```bash
npm run watch -- --demo --mutate 20 --interval 10   # watch the loop heal itself
```

**Exit codes, for schedulers:** `0` when the last cycle ended healthy or self-healed, `1` when it
ended red and unhealed — so cron/CI can fail loudly. `--on-alert "command"` runs something the
moment a cycle goes red (webhook, desktop notification); the one-line summary arrives in the
`SCRAPE_HEAL_ALERT` env var. State persists in `.scrape-heal/state.json`, so a restart resumes the
healed config — no re-detecting, no re-healing.

## Any scraper, not just Playwright

The loop's contract with your scraper is one sentence: **give me the rows.** JSON, JSON Lines, or
CSV — on stdout or in a file. The scraper that produces them is irrelevant; Playwright is just the
built-in source.

```bash
npm run demo:any     # a deliberately dumb fetch+regex scraper, healed the same way
```

- `--rows-from "<cmd>"` — run the command each cycle, parse stdout (Scrapy, Puppeteer, bs4, anything).
- `--rows-file <path>` — watch a file your existing scraper already writes (a cron dump, a CSV).
- `--url` is only needed for **self-healing** (the browser re-measures the page). Without it the loop
  is a plain detector: it validates and alerts, and refuses to guess at repairs.
- A scraper that **crashes** (non-zero exit, no parseable output) is reported as a scraper failure,
  not a site change — the loop never "heals" a scraper that merely errored.

Copy-paste recipes for **Scrapy**, **Puppeteer**, and a **legacy cron dump** →
**[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.

## When even the data changes (LLM repair)

Text matching dies the moment the redesign *also changes the values* — nothing on the page equals
a known value anymore, so there is no anchor to hunt. That's the one case where structure has to
carry intent. Point scrape-heal at any OpenAI-compatible endpoint and the healer falls back to
asking the model where each field now lives:

```bash
npm run demo:llm       # keyless: redesign + brand-new values, healed by a mock LLM
npm run watch          # real: set the env vars below (or llm.apiKey in the config)
```

```
SCRAPE_HEAL_LLM_API_KEY=sk-...
SCRAPE_HEAL_LLM_MODEL=gpt-4o-mini
SCRAPE_HEAL_LLM_BASE_URL=https://api.openai.com/v1   # OpenRouter, Groq, Ollama, LM Studio — any /v1/chat/completions
```

The model only **proposes**. The candidate config is still re-run against the live page, and a
proposal that doesn't extract the right shape is refused with the same loud alert as any other
failed repair — a bad model guess is exactly as safe as a bad text guess. When the old values are
gone for real (the data changed), the gate verifies shape **and value types** honestly — right
count, no empty fields, values still look like themselves — and says so in the log instead of
pretending it verified the data. A model that binds `price` to a `.badge` that says "On sale"
passes the shape check (it has text!) and is caught by the type check instead, then told exactly
that before it retries. Propose with the model, **verify with the browser** — the split stays
intact.

**It learns from its misses.** A failed proposal — the verification issues plus the real
selector-hit counts from the live page — is fed back and the model tries again, up to
`llm.maxAttempts` (the repair budget, default 3). Every verified repair and every miss is
remembered **per site** in state, so the next time the same site breaks, the model starts from
what it already learned instead of from scratch — and it's told which proposals failed before,
so it doesn't repeat them.

**See what it has learned.** `scrape-heal --memory <site>` prints the verified repairs and failed
proposals the loop remembers for that site; `scrape-heal --memory` lists every site it remembers.

## The gate refuses wrong bindings (value-type verification)

Shape checks prove a repair extracted *something*; the identity check proves it found the *same
rows*. Neither can tell a correct binding from a wrong one — after a redesign, a `price` selector
that lands on *any* element with text ("Price on request") is non-empty, identities check out, and
without a third check the repair ships silently corrupted data.

So every repair — text pass and LLM pass alike — is also checked against **how the data looked in
the last good run**. Each field's values get a type profile (price, percentage, date, URL, image,
number, code/SKU, or plain text) with a consistency score. A repaired extraction must still look
like that kind of data; when it doesn't, the repair is refused and the loop keeps trying:

```
heal: FAIL — field "price" values no longer look like a price (was 100% a price, now 0%) —
the selector may bind the wrong element; refusing the repair. Nothing shipped.
```

The taxonomy is deliberately conservative and built for real redesigns: a dropped `$` sign still
passes (price ↔ number), a word field may flip between "in stock" and "Available", and a code
field must not start yielding prose. When a site genuinely changes a field's format, tell the
loop and it stops demanding the old shape:

```jsonc
"fieldTypes": { "price": "price", "stock": "text" },  // override a field's kind
"verifyValueTypes": false                              // or disable the check entirely
```

(Skipped automatically when a pluggable `validator` is set — your schema decides.)

## How good is the repair? (benchmark)

"Self-healing" is a claim; the benchmark makes it a number. `npm run benchmark`
runs the real loop against 15 recorded redesigns — each one a live
before/after pair, a real baseline capture, and the real browser + verify gate
(a mock LLM stands in for the repair budget when the data itself changed):

```bash
npm run benchmark                    # every scenario, the rate at the end
npm run benchmark -- --min-rate 0.9  # exit 1 if the rate ever falls below
```

Current result: **15/15 — 100%**.

| Kind | Score | What it covers |
|---|---|---|
| Text pass | 5/5 | class renames, wrapper layers, partial renames, list→grid, URL-valued fields |
| LLM pass | 6/6 | values changed, currency format, date format, case changes, wrong-guess retry, prose-binding correction |
| Refusals | 4/4 | prose where prices should be, vanished data, moved attribute fields, thinned assortments |

A scenario *passes* only if the shipped config re-extracts the right data from
the redesigned page — right shape, right value kinds, right identities. The
refusals count as passes: when verification can't be satisfied, shipping
nothing **is** the repair. That's also the honest envelope — an
attribute-valued field like an `<img src>` has no visible text to anchor on,
so the loop correctly refuses rather than guess.

The benchmark is a regression floor, not a claim about every site on the
internet. The corpus lives in `benchmark/scenarios.ts` — add a scenario when
you find a redesign that beats the loop. CI runs it with `--min-rate 0.9`:
a change that slips the rate fails the build.

## Your schema, your rules (pluggable validators)

The built-in checks are deliberately boring — enough items, no empty fields, same identities.
When you already own a schema, plug it in instead:

```bash
npm run demo:validator    # example: a USD-price rule on top of the shape checks
npm run watch -- --validator my-schema.js
```

`my-schema.js` exports one function:

```js
export default (items, { config, baseline }) => ({
  ok: items.every((it) => /^\$\d/.test(it.price)),   // your rule
  itemCount: items.length,
  issues: [],                                          // filled in when ok is false
});
```

It replaces the built-in shape checks *everywhere* — healthy runs, ledger hits, and the repair
verify gate — so your schema is what "good" means, not a second opinion.

## What broke: transient, blocked, or breakage? (v3)

A red run is not one thing, and treating it as one thing is how scrapers heal
pages that never actually broke. Every fetch is classified before the loop
decides anything:

| Signal | What it means | What the loop does |
|---|---|---|
| **Transient** — 5xx, timeout, connection reset, DNS error | the site was temporarily unreachable | retry with exponential backoff, up to 3 attempts; if it persists, alert — **never heal** |
| **Block** — 403, 429, a captcha/Cloudflare wall (even one answering 200) | the site refused us | rotate to the next proxy from the pool (when configured) and retry; without a pool, alert and point at `proxy` — **never heal** |
| **Loaded, wrong shape** — page fine, selectors match nothing | a real redesign | the healer — the only case that repairs |
| **Source crashed** — command exited non-zero, no parseable rows | your scraper broke, not the site | red + alert — **never heal** |

A navigation timeout used to throw straight out of the loop; a single 503 used
to be indistinguishable from a redesign. Now the loop says which it was, in
its own words:

```
  transient fetch failure (HTTP 503) — attempt 1/3, retrying…
  proxy http://user:pass@host:8080 blocked — cooling it down and rotating
```

There is nothing to configure — retries and classification are always on.
`maxFetchAttempts` (default 3) is exposed on the library for tuning.

## Evidence on red (v3)

A red alert used to be a one-line summary and a guess. Now every red cycle
keeps receipts — the screenshot, the DOM snapshot, and the HTTP status (when
there was one) — written under `<stateDir>/evidence/<target>/`, kept 5 per
target, and attached to the alert:

```
  evidence → evidence/shop-a/2026-08-11T21-13-48-153Z-000_screenshot.png
```

- **Alerts** — the generic webhook receives the whole evidence record
  (`evidence: { reason, status, screenshot, dom, at }`); Slack/Discord get a
  text line (`evidence → HTTP 403 · screenshot: … · dom: …`); the `onAlert`
  shell hook gets it in `SCRAPE_HEAL_EVIDENCE` as JSON.
- **Dashboard** — each card shows the last red cycle's screenshot inline
  (served by the dashboard itself at `/evidence/…`), the reason, the status,
  and a link to the DOM snapshot. "Why is it red" has an answer that doesn't
  require trusting the log.
- **The API server** includes the evidence record in every `/run` result.

Capture is strictly best-effort — a failed screenshot never takes the loop
down, and a crashed rows-source (no page to look at) still gets a reason-only
record so the alert shape never changes.

## Pages that paginate (v2)

Most sites spread their data across pages, and page 1 is a fraction of the catalog. Configure a
strategy and the loop walks every page before validating — so the baseline, the heal, and the
verify all see the *whole* data set, not a slice:

```jsonc
{
  "pagination": { "kind": "next-link", "selector": ".pagination .next" }
  // kinds: "next-link" | "load-more" | "infinite-scroll" | "url-pattern"
  //        "url-pattern": { "kind": "url-pattern", "pattern": "/products?page={page}" }
  // caps:  "maxPages": 20, "maxItems": 500, "pageWaitMs": 1000
  //        "dedupeField": "name"   // dedupe across pages (default: identityField)
}
```

```bash
npm run watch -- --pagination next-link --pagination-selector ".pagination .next" --pagination-max 20
```

Traversal stops on safety caps, a dead next link, or a page of pure duplicates; `maxItems` keeps
a runaway catalog from ever running forever. The library also ships `detectPagination(page)` —
a best-effort auto-detector of the four strategies — for wiring your own bootstrap.

## Anti-bot rotation (v2)

When a site blocks you, one IP is the end of the story. A configured proxy pool is scored on
every use — successful proxies build a latency average, and a proxy that returns a block signal
(HTTP 403/429, a Cloudflare challenge, a captcha page) is cooled down with exponential backoff
and skipped until it recovers (a 5xx is the *site's* fault and never penalizes the proxy). Dead
proxies are removed, cooled proxies return, and the pool self-heals:

```jsonc
{
  "proxy": {
    "proxies": ["http://user:pass@host1:8080", "http://user:pass@host2:8080"],
    "providerUrl": "https://my-provider.example/proxies",   // JSON array of proxy URLs
    "providerRefreshSeconds": 120,                          // re-fetch the pool on a cadence
    "cooldownBaseSeconds": 30,                              // doubles per consecutive failure
    "cooldownMaxSeconds": 300
  }
}
```

```bash
npm run watch -- --proxy "http://p1:8080,http://p2:8080" --proxy-provider "https://my-provider.example/proxies"
```

Block detection is signature-based: status codes plus page-content markers
(`cf-browser-verification`, *"Just a moment"*, *"DDoS protection"*, `captcha`, `Access Denied` …).
The pool is wired into the loop: every fetch runs through the current proxy, a blocked proxy
is cooled down and rotated, and a 5xx from the site never unfairly penalizes a healthy proxy
(it's the site's fault, not the proxy's). The pool is also a full class (`ProxyPool`) with
`next()` / `record()` / `isBlocked()` exposed on the library, for your own integrations.

## Pages behind a login (v2)

Most valuable data is behind a login wall. Three modes, and credentials never touch the config
file:

```jsonc
{ "auth": { "kind": "attach", "cdp": "http://127.0.0.1:9222" } }
//   1. attach — drive a browser you already signed into (CDP); your session is used as-is
{ "auth": { "kind": "profile", "dir": "./browser-profile" } }
//   2. profile — a persistent browser context: sign in once, cookies survive restarts
{ "auth": {
    "kind": "login", "loginUrl": "https://app.example.com/login",
    "userSelector": "#email", "passSelector": "#password", "submitSelector": "button[type=submit]",
    "rememberSelector": "#remember", "settleMs": 3000,
    "successSelector": ".avatar", "sessionPath": ".scrape-heal/session.json" } }
//   3. login — fill the form programmatically, save the session, skip login next time
```

```bash
SCRAPE_HEAL_AUTH_USER=you@example.com SCRAPE_HEAL_AUTH_PASS='...' npm run watch
# or with flags: --auth login --auth-login-url ... --auth-user-selector ... --auth-session .scrape-heal/session.json
```

The login flow reads credentials only from `SCRAPE_HEAL_AUTH_USER` / `SCRAPE_HEAL_AUTH_PASS` —
they're never stored, written, or logged. A saved session is validated on load (a dead session
silently re-logs-in), and `attach` never closes the browser you're using. The module is
`authenticate(browser, config)` on the library — the loop wiring to hold a session open across
cycles is the integration step on deck.

## Where the data goes (v2 pipelines)

A scraper that only logs to console is a toy. Pipelines deliver healthy rows downstream after
every verified cycle — and a dead downstream can never take the scraper down with it (failures
are logged, never fatal):

```jsonc
{
  "pipelines": [
    { "kind": "webhook", "url": "https://my-api.example.com/ingest", "secret": "hmac-secret" },
    { "kind": "webhook-batch", "url": "https://my-api.example.com/ingest", "headers": { "x-team": "data" } },
    { "kind": "file", "path": "./data/products.jsonl" },   // .jsonl appends; .json overwrites
    { "kind": "postgres", "connection": "postgres://…", "table": "products", "conflictColumn": "name" },
    { "kind": "mysql", "connection": "mysql://…", "table": "products", "batchSize": 100 }
  ]
}
```

- **webhook** posts one request per row; **webhook-batch** posts the array once. With a `secret`,
  every payload carries an HMAC-SHA256 signature in the `x-scrape-heal-signature` header.
- **file** appends JSON Lines (`.jsonl`/`.ndjson`) or rewrites pretty JSON.
- **postgres / mysql** upsert into a table via `registerDbRunner()` — the DB driver is injected
  rather than hard-depended on, so you supply the `pg` / `mysql2`-backed function:

```js
import { registerDbRunner } from 'scrape-heal';
import pg from 'pg';

registerDbRunner(async (pipeline, rows) => {
  const client = new pg.Client({ connectionString: pipeline.connection });
  await client.connect();
  // ... upsert `rows` into pipeline.table, conflict on pipeline.conflictColumn ...
  await client.end();
});
```

The library also exports `retry(fn, { maxAttempts, baseDelayMs, maxDelayMs, jitter })` —
exponential backoff with jitter for flaky HTTP paths.

## Extend the loop (v2 plugins)

Plugins open the loop at three points without touching its code. Each file in `pluginsDir`
(default-exports a plugin object, or a function that returns one):

```jsonc
{ "pluginsDir": "./scrape-heal-plugins" }
```

```js
// scrape-heal-plugins/normalize.mjs
export default {
  name: 'normalize-currencies',
  kind: 'transform',                                // runs after extraction, every cycle
  match: (url) => url.includes('shop.'),
  transform: (rows) => rows.map((r) => ({
    ...r,
    price: r.price?.replace(/[^0-9.]/g, ''),
  })),
};
```

Three kinds, tried in registration order with the built-in logic as fallback:

| Kind | Hook | Example use |
|---|---|---|
| `extractor` | replace *how* rows are produced | GraphQL introspection, RSS parsing, a CSV download |
| `healer` | site-specific repair logic | "this site always renames classes with a `v2-` prefix" |
| `transform` | post-process extracted rows | clean whitespace, parse dates, normalize currencies |

```js
// programmatic — register at startup, load from a directory, or both
import { registerPlugin, loadPlugins } from 'scrape-heal';
registerPlugin({ name: 'my-healer', kind: 'healer',
  match: (url) => url.includes('example.com'),
  heal: async (page, config, baseline) => { /* ... return { config, verified } or null */ } });
await loadPlugins('./my-plugins/');
```

**Transform plugins are wired into the loop.** Extractor and healer plugins are ready on the
library (`tryExtractors` / `tryHealers`) — hooking them ahead of the built-in extractor/healer in
the watchdog is the integration step on deck.

## When even the DOM is a blank (v2 visual extraction)

A redesign can obliterate every class name *and* change the values. The last resort is to look at
what the page actually renders. When DOM extraction returns zero items, the loop runs **layout
analysis in the browser** — it finds the repeating grid of same-height, same-edge rows, maps each
cell back to a DOM element by hit-testing, and reconstructs the rows. Free, immediate, no external
service:

```bash
npm run watch -- --demo --mutate-values 8 --interval 5 --cycles 8
# the DOM dies; the loop reads the grid off the pixels and keeps the data flowing
```

For the truly hostile case — canvas/WebGL/WASM-rendered pages where *nothing* is in the DOM — an
**OCR seam** is built in: `setOcrEngine(engine)` takes a screenshot → text function (Tesseract
WASM, Google Vision, AWS Textract — any engine), and `ocrPage(page)` returns the page text from
pixels. `detectGrid` / `extractByGrid` / `ocrPage` / `setOcrEngine` are all exported.

## Run it as a service (v2 REST API)

Instead of the watchdog owning the process, expose the loop as HTTP endpoints — a scheduler
(cron, a cloud function, a manual `curl`) triggers a cycle and reads the result. State lives in
the same per-target files the dashboard reads, so the server and a dashboard can run side by side:

```js
// api.ts — from a clone, import the source; from the package, use 'scrape-heal'
import { startApi } from './src/api.ts';
await startApi({ stateDir: '.scrape-heal', port: 4200, log: console.log });
```

```bash
npx tsx api.ts
curl http://localhost:4200/targets            # list targets + last status
curl -X POST http://localhost:4200/run        # one cycle on every target
curl -X POST http://localhost:4200/run/example.com   # one cycle on one target
```

| Endpoint | What it gives you |
|---|---|
| `GET /health` | liveness check |
| `GET /targets` | configured targets and their last status |
| `GET /targets/:id` | one target's full state |
| `POST /run` | run one cycle on every target, return results |
| `POST /run/:id` | run one cycle on one target |
| `GET /state` | full state dump, for scripts |
| `GET /events` | SSE stream of cycle results — real-time board feed |

A shared browser is launched once and reused across cycles.

## Scrape behind a login (v3: auth wired into the loop)

Most valuable data is behind a login wall. The loop now holds the authenticated
session across **every** cycle — fetching, pagination, the visual fallback, the
selector ledger, healing, and evidence capture all run through it — so a
login-walled page is scraped and healed like any other page, instead of being
seen as an anonymous site that mysteriously returned a login form.

Three modes (`auth.kind`):

| Mode | What it does | Config |
|---|---|---|
| `attach` | drive a browser you already signed into (CDP) | `{ "kind": "attach", "cdp": "http://127.0.0.1:9222" }` |
| `profile` | persistent profile — sign in once, scrape forever | `{ "kind": "profile", "dir": "./browser-profile" }` |
| `login` | programmatic form login; credentials never touch disk | `{ "kind": "login", "loginUrl": "…", "userSelector": "#user", "passSelector": "#pass", "submitSelector": "#submit", "successSelector": ".dashboard" }` |

Credentials are never stored or logged — `login` reads `SCRAPE_HEAL_AUTH_USER` /
`SCRAPE_HEAL_AUTH_PASS` from the environment at startup, and an optional
`sessionPath` saves the session so the next run skips the form (an expired one
re-logs-in automatically).

- **Session held across cycles** — the context is opened once, before the first
  cycle, and closed when the loop exits. Every page the loop touches comes from it.
- **Combined with proxy rotation** — Playwright proxies are per-context, so each
  per-fetch context re-applies the session (cookies + localStorage) on top of
  the current proxy. `attach` is the one exception (your own browser's context
  can't be re-proxied).
- **Fail fast** — a login that fails (wrong credentials, missing env vars, a
  down CDP browser) stops the loop with a loud message instead of silently
  scraping the anonymous site for days.
- **When the session expires mid-watch** — the cycle goes red like any other
  breakage, and the healer says so honestly: a login wall is not a redesign.

## Watch a fleet (multiple targets)

One config file, many sites — the top-level keys are the defaults, `targets` overrides per site.
Each target runs its own concurrent watchdog with its own selectors, cadence, repair budget,
validator, and state file — and every v2 feature is per-target too (pagination, pipelines, proxy,
LLM memory):

```jsonc
{
  "intervalSeconds": 300,          // default for every target
  "llm": { "model": "gpt-4o-mini" },
  "targets": [
    {
      "url": "https://shop-a.example.com/products",
      "fields": { "name": ".name", "price": ".price" },
      "llm": { "maxAttempts": 5 },              // this site gets a bigger repair budget
      "pagination": { "kind": "next-link", "selector": ".pagination .next" }
    },
    {
      "url": "https://shop-b.example.com/items",
      "validator": "validator-b.js",            // its own schema
      "alerts": { "slack": "https://hooks.slack.com/…" },   // its own channel
      "intervalSeconds": 600,                   // its own cadence
      "pipelines": [ { "kind": "file", "path": "./data/shop-b.jsonl" } ]
    }
  ]
}
```

`scrape-heal` runs one watchdog per target — a red run on any of them repairs or alerts
independently, and the exit code is 1 if *any* target ended red. State lives per target
(`.scrape-heal/<host:port>.json`), so healed configs and per-site LLM memory never cross wires.

## Alert the humans, not just the scheduler

`alerts` posts to real channels the day a run goes red and can't be repaired — Slack or Discord
incoming-webhook URLs, or any generic JSON webhook (which receives the raw message and can feed
anything else):

```jsonc
"alerts": { "slack": "https://hooks.slack.com/…", "discord": "…", "webhook": "https://…" }
```

Per-target in a fleet config. Delivery is best-effort — a dead webhook is logged, never fatal.

A target that stays broken doesn't ping the channel every cycle — `alerts.cooldownMinutes`
(default 60) throttles to **one alert per target per window**, and the last-alert time is
persisted in state so the cooldown survives restarts. Set it to `0` to alert every red cycle.

**Flip-flopping sites cost nothing after the first heal.** Every proven config — the original one
and every verified repair — goes into a mini-ledger (persisted in state). When a cycle goes red,
the loop first tries the remembered configs against the live page; the moment one re-extracts the
same data, it's shipped as a `LEDGER HIT` without re-healing. A site that toggles between markup
versions (A/B rollouts, cached deploys, rollbacks) is healed once and remembered forever after:

```bash
npm run watch -- --demo --mutate-flip 12 --interval 5 --cycles 14   # flip-flop demo
```

## The other half: change watching (v3)

The loop above is a *breakage* detector — it reacts when extraction stops
working. But the most valuable thing a scraper can notice is often that the
data *changed while everything still worked*: a price dropped, an item went
out of stock, a new product appeared. That's what `watch` is — a structural
diff of every healthy cycle against the previous one, matched by identity, so
the report says *which* product changed and *how*, not "the page is different":

```bash
npm run watch -- --demo --mutate-values 8 --interval 5 --cycles 8
```

When the data changes (same shape, new values — the healthy path), the log
shows the diff and the report lands in the dashboard:

```
[cycle 3] OK — 6 item(s), shape matches the last good run
  changes vs the last good run:
  ~ Wireless Mouse · price: "$24.99" → "$19.99" (-5.00, -20%)
  ~ Mechanical Keyboard · stock: "in stock" → "out of stock"
```

**Alert on thresholds.** Set `alerts.onChange: true` and list what's worth a
ping — a 5% price drop, a restock, a new listing:

```jsonc
{
  "watch": {
    "thresholds": [
      { "field": "price", "dropPercent": 5 },          // price dropped ≥ 5%
      { "field": "stock", "changedTo": "in stock" },   // restocked
      { "field": "stock", "changedFrom": "out of stock" },
      { "field": "status", "anyChange": true },
      { "added": true }                                  // any new item
    ]
  },
  "alerts": { "onChange": true, "changeCooldownMinutes": 60 }
}
```

`dropPercent`/`risePercent` are numeric (currency/grouping/percent noise is
stripped: `$24.99` parses as `24.99`); `changedTo`/`changedFrom` are exact
trimmed string matches. With no thresholds, `onChange: true` alerts on any
change. Change alerts have their own cooldown (`changeCooldownMinutes`,
default 60, `0` = every qualifying change), tracked separately from the
red-cycle cooldown — so a price-drop ping never suppresses a breakage alert
or vice versa. `--no-watch` turns the diffing off entirely.

## Watch it live (dashboard)

The state files are already a database — the dashboard is a tiny SSE server that turns them
into a live board: every target's last cycle, heal history (the ledger), and learned rules
(per-site LLM memory) at a glance.

```bash
npm run dashboard                    # scrape-heal --dashboard — open the printed URL
# in another terminal:
npm run watch -- --demo --mutate 6 --interval 5 --cycles 8
```

Each target is a card — a status pill (healthy / repaired / red), items vs. the expected
minimum, alert count, last-healed time, the proven-config ledger, the per-site LLM memory, the
last change-watching report, and — when a cycle went red — the captured screenshot, HTTP
status, and DOM-snapshot link as evidence. Zero dependencies, one self-contained page, and it
works for a fleet: every target's state file appears the moment its watchdog writes. `GET /state`
returns the same view as JSON for scripts; `--dashboard <port>` picks a port (busy ports fall
back to a free one), and `--state-dir`/`stateDir` points at whichever directory the state files
live in.

## The library API

The whole loop is a few functions — embed it in your own scheduler, server, or scraper:

```js
import { runWatchdog, commandRows } from 'scrape-heal';
import { chromium } from 'playwright';

// watch any scraper that prints JSON/CSV, every 5 minutes, forever
const browser = await chromium.launch();
runWatchdog(browser, await browser.newPage(), {
  intervalSeconds: 300,
  statePath: '.scrape-heal/state.json',
  fetchRows: commandRows('python my_scrapy_spider.py --json'),
  writeConfigPath: 'scraper.config.json',
  log: console.log,
}, {
  url: 'https://example.com',
  items: '.product-card',
  fields: [{ name: 'name', selector: '.name' }],
  identityField: 'name',
  minItems: 4,
});
```

Or skip the loop and use the pieces directly: `extract` pulls rows out of a page, `validate`
checks them against the last good run, `heal` proposes and verifies a repair. Everything —
`runWatchdog`, `heal`, `scrapeWithSelfHealing`/`withSelfHealing`/`repairSelectors`, `ProxyPool`,
`authenticate`, `extractAllPages`, `detectPagination`, `detectGrid`/`extractByGrid`/`setOcrEngine`,
`runPipelines`/`registerDbRunner`/`retry`, `registerPlugin`/`loadPlugins`, `startApi`,
`startDashboard`, `sendAlert`, `loadValidator`, `parseRows`, `rememberLLM`,
`classifyValue`/`verifyValueTypes` — is exported from the package root, fully typed.

## Drop-in adapters (Scrapy, Crawlee, plain Playwright)

Already have a crawler? Don't migrate — plug the loop into it. The pattern is
identical everywhere: your rows are validated against the last good run; when
they stop matching, the loop re-derives the selectors in a real browser and
**proves** the repair on the live page before anything changes.

| Adapter | What it does | File |
|---|---|---|
| **Playwright** | `scrapeWithSelfHealing()` — extract, validate, and heal in one call | `integrations/playwright.mjs` |
| **Crawlee** | `withSelfHealing()` — a per-request guard around your extraction | `integrations/crawlee.mjs` |
| **Scrapy** | a spider middleware that keeps your last good rows and repairs the config the moment an item breaks | `integrations/scrapy_middleware.py` |

```js
// plain Playwright — the whole loop in one call
const { rows, config: fixed, repaired } = await scrapeWithSelfHealing({
  browser, config,
  extractRows: async () => rowsFromDom(page),
  lastGoodRows,                        // your last good run; [] on first
});
```

The Node adapters call the loop directly (from npm they're package-root
exports). The Scrapy middleware is Python, so it shells out to a new one-shot
command — **"fix it now" without a watchdog**:

```bash
scrape-heal repair --config scraper.config.json --rows last-good.json
# re-measures the live page, heals the selectors, rewrites the config, exits 0/1
```

`repair` takes the config and your last good rows (JSON/JSONL/CSV, from a file
or `--rows-from "<cmd>"`), rewrites the selectors in place — preserving every
other config key — and exits 1 with nothing modified when no repair can be
verified. Pair it with the middleware for drop-in self-healing, or with cron
for a nightly "heal me if I broke" job. Full recipes: docs/INTEGRATIONS.md.

## What it refuses to do

- **Ship unverified repairs.** If the candidate doesn't re-extract the same data, you get a log
  instead of a broken config.
- **Invent data.** The repaired run must contain everything the last good run contained.
- **Trust the model.** An LLM proposal is a proposal; it still has to pass the verify gate.
- **"Heal" a crashed scraper.** A non-zero exit is a scraper bug, not a site change.
- **Guess at repairs without a URL.** Detection-only mode validates and alerts; it never rewrites
  selectors it can't re-measure.
- **Heal a page that never responded.** A 503, a timeout, or a captcha wall is not a broken
  selector — it's retried, rotated, or alerted about, never repaired.

## What's next (honestly)

v2 shipped the pieces; v3 added change watching and failure classification
(transient retries, proxy rotation on blocks, heal-only-on-breakage). The
remaining seams:

- **Hook extractor/healer plugins into the loop** — transforms run already; extractors and
  healers should be tried before the built-ins.
- **Auto-detect pagination** — `detectPagination()` exists; a `--pagination auto` mode would
  adopt a detected strategy on first sight.
- **OCR engines** — the seam is built; a bundled Tesseract-WASM fallback would make the canvas
  case zero-setup.

## The point

Scrapers break constantly and silently. The fix isn't better selectors — it's a loop that notices,
repairs, and **proves** the repair. If that loop had existed, the *"Weekly update failed"* issues
that litter GitHub would mostly not exist.

---

<div align="center">

MIT licensed · [issues & ideas welcome](https://github.com/Swastikbhat-lab/scrape-heal/issues) · [contributing](CONTRIBUTING.md)

⭐ Star it if your cron job has ever silently returned nothing.

</div>
