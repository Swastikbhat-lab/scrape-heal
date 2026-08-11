# Show HN: scrape-heal — a scraper that repairs its own selectors

## How to post (30 seconds, needs your HN account)

1. Go to **https://news.ycombinator.com/submit** (logged in).
2. **Title:** `Show HN: scrape-heal – a scraper that fixes its own broken selectors`
3. **URL:** `https://github.com/Swastikbhat-lab/scrape-heal`
4. Submit, then immediately add the body text below as the **first comment** on
   your own post (that's how the story and the two questions ship).
5. Post on a **weekday morning (US)** and stay in the thread for the first 2–3
   hours — reply fast, the comment section is the product.

Reply templates for the ten most likely comment types are pre-drafted in
**`marketing/show-hn-replies.md`** — adapt each to the actual comment before
posting.

---

## Body (first comment)

My scraper broke at some point last month and I found out when a spreadsheet came
back empty a week later. No error. The site just renamed a few classes in a redesign
and my `$('.price')` was suddenly pointing at nothing.

So I built the thing I wished existed: a scraper loop that remembers what the data
looked like, notices when it stops looking like that, and repairs its own selectors —
but only after proving the repair on the live page.

It's small — ~1.2k lines of TypeScript, MIT, no dependencies beyond Playwright — and
the demo is the whole pitch:

```
STEP 1 — the site is healthy, the scraper works
  ✓ extracted 4 item(s) — schema OK
      1. Wireless Mouse  |  $24.99
      2. Mechanical Keyboard  |  $89.00
      ...

STEP 2 — the site redeploys overnight. Nobody tells the scraper.
  ✗ extracted 0 item(s) — BROKEN
    - expected at least 4 item(s), got 0

STEP 3 — the healer wakes up. It knows what the data used to look like.
  heal: item container candidate ".item" — 4 match(es) on the page
  heal: field "name" — candidate "h2.title" (4 match(es))
  heal: verifying on the live page…
  heal: PASS — 4 item(s), every known value present. Shipping the repair.

STEP 4 — repaired, and only because verification passed
  ✓ data is identical to the last good run — nothing lost, nothing invented.
```

The part I'm most proud of: it refuses to ship anything it can't verify. The repair
only lands if re-extracting from the live page yields the same items as the last good
run. A healer that doesn't verify is just a more confident way to break your data.

https://github.com/Swastikbhat-lab/scrape-heal

Questions I'd genuinely like input on:
- The "known data" trick breaks when the *data* changes, not just the markup — is
  structure-based repair (LLM or otherwise) the right answer there, or is there
  something dumber that works?
- Anyone here actually running scrapers in production: how do you find out about
  breakage today? Waiting for a dashboard to go red? Or the empty-spreadsheet method?
