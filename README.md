# scrape-heal

**Your scraper breaks when the site redesigns. This fixes itself — or tells you exactly what broke.**

Web scrapers have one job and it falls apart in the most boring way possible: the site
renames a class, moves a `<div>`, and suddenly your 3am cron job extracts *nothing*.
Not an error, not a warning. Just an empty spreadsheet that you notice a week later.

scrape-heal is a proof of concept for the fix: a scraper that **remembers what the data
looked like**, notices when it stops looking like that, and repairs its own selectors —
but only after proving the repair works on the live page.

<p align="center">
  <img src="docs/demo.gif" alt="scrape-heal demo: a healthy run, a silent redesign, breakage detected, then the selectors repaired and verified on the live page" width="640">
</p>

```
healthy → site redesigns → BROKEN → healer wakes up → repair verified → same data out
```

## Run it

```bash
npm install
npx playwright install chromium
npm run demo
```

*(The GIF above was generated, not recorded — `npm run make:gif` re-renders it
from the same transcript whenever the demo's story changes.)*

You'll watch a full break-and-recover cycle against a fake storefront:

```
STEP 1 — the site is healthy, the scraper works
  ✓ extracted 4 item(s) — schema OK
      1. Wireless Mouse  |  $24.99
      2. Mechanical Keyboard  |  $89.00
      3. USB-C Hub  |  $39.50
      4. 4K Monitor  |  $299.00

STEP 2 — the site redeploys overnight. Nobody tells the scraper.
  ✗ extracted 0 item(s) — BROKEN
    - expected at least 4 item(s), got 0

STEP 3 — the healer wakes up. It knows what the data used to look like.
  heal: item container candidate ".item" — 4 match(es) on the page
  heal: field "name" — candidate "h2.title" (4 match(es))
  heal: field "price" — candidate "span.amount" (4 match(es))
  heal: verifying ".item" + name:"h2.title", price:"span.amount" on the live page…
  heal: PASS — 4 item(s), every known "name" present. Shipping the repair.

STEP 4 — repaired, and only because verification passed
  new config: items ".item"
              name -> "h2.title"
              price -> "span.amount"

  ✓ data is identical to the last good run — nothing lost, nothing invented.
```

## How it works

Three moving parts, each boring on purpose:

1. **Detect** — every run extracts against your selector config and validates the
   result against a schema: enough items, no empty fields, every identity value from
   the last good run still present. A selector that returns *wrong-shaped* data is
   treated as broken, because it is.

2. **Heal** — the last good run *is* the ground truth. The healer looks at the live
   page for elements that still contain those exact values, and derives new selectors
   from them. No guessing, no regex archaeology: it knows the products are called
   "Wireless Mouse" and "$24.99", so it finds them.

3. **Verify — the load-bearing step** — the candidate config is re-run against the
   live page, and the repair is only shipped if the schema validates **and** every
   known item is still there. If verification fails, nothing is shipped. A healer
   that doesn't verify is just a more confident way to break your data.

## What it refuses to do

- **Ship unverified repairs.** If the candidate doesn't re-extract the same data,
  you get a log instead of a broken config.
- **Invent data.** The baseline comparison is the whole safety story — the repaired
  run must contain everything the last good run contained.

## What's next (honestly)

This is a PoC, ~300 lines, deliberately. The interesting next steps:

- **LLM-assisted repair** for the cases text-matching can't reach (selectors whose
  *values* changed too — then you need to infer intent from structure).
- **Watchdog mode** — run on a cadence, alert the moment a run goes red instead of
  the day after.
- **Any scraper, any framework** — this is a loop, not a scraper; wiring it to
  Playwright/Puppeteer/Scrapy output is an adapter, not a rewrite.
- **The anti-detection arms race** is real and this isn't that. This is about the
  99% case: markup changed, data still there, nobody noticed.

## The point

Scrapers break constantly and silently. The fix isn't better selectors — it's a loop
that notices, repairs, and **proves** the repair. If that loop had existed, the
"Weekly update failed" issues that litter GitHub would mostly not exist.

Made for fun, MIT licensed, feedback welcome.
