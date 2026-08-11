# CTO Technical Post — Dev.to / Hashnode ready

**Persona: Startup CTO.** Pragmatic, ship-first, allergic to over-engineering.
This post is the "engineers will read it" companion to the launch posts.

---

## Your scraper didn't break. The site changed — and nobody noticed.

*The most expensive bug in data extraction has no error message.*

Every scraper I've ever run has broken the same way. Not with a crash. With a
silent zero: the site redeploys, renames `.price` to `.amount`, and my 3am cron
job starts extracting nothing. The spreadsheet comes back empty a week later and
that's when I find out.

The fix isn't better selectors. Selectors are fragile by construction — they're a
promise about someone else's markup. The fix is a **loop** that notices when the
promise breaks, repairs it, and — this is the load-bearing part — *proves the
repair before shipping it*.

I built that loop as a PoC: [scrape-heal](https://github.com/Swastikbhat-lab/scrape-heal),
~300 lines, MIT. This post is the design, because the design is the product.

### The three moves

**1. Detect — treat "wrong shape" as broken, not just "empty".**

Most breakage checks are "did the request fail?". The boring failure mode is the
request succeeding and the extraction returning garbage-shaped data. So every run
validates against a schema: enough items, no empty fields, every identity value
from the last good run still present. A selector that returns the wrong-but-shaped
data is broken, because it is.

**2. Heal — the last good run is your ground truth.**

Here's the trick that makes repair safe without a model: you *know* what the data
used to look like. The scraper extracted "Wireless Mouse" and "$24.99" last week.
So when selectors die, walk the live page and find the elements that still contain
those exact values. Derive new selectors from those elements. No regex archaeology,
no guessing about intent — the data itself tells you where it moved.

The leaf rule is what makes this precise: an element only matches if none of its
children carry text of their own, so `body` (whose text contains everything) can't
accidentally match.

**3. Verify — the step that makes it a tool and not a party trick.**

The candidate config gets re-run against the live page. The repair is shipped only
if the schema validates **and** every known item is still there. If verification
fails, nothing ships. A healer that doesn't verify is just a more confident way to
break your data — and that's the failure mode that gives auto-fixers a bad name.

### What's boring on purpose

- Playwright for the browser, because measuring the real rendered page is the whole point.
- Exact-string selectors, because a regex that "might match" is how one fix quietly rewrites half the site.
- No LLM in the loop yet — text matching is free, deterministic, and explainable. The model is for the cases text matching can't reach.

### The honest limits

The "known data" trick assumes the data still exists, just moved. If the site
renames the products too — the titles themselves change — text matching finds
nothing, and the tool correctly refuses to guess. That's the case I'd reach for
LLM-assisted repair, where the model proposes candidates but the browser still
verifies them. Propose with AI, verify with measurement. The verification never
gets to be creative.

### Why this matters now

The scraping ecosystem is crowded on the *building* side — frameworks, APIs,
proxy networks, anti-bot arms races. The *maintenance* side is a graveyard. The
one product that tried (DataHen Till) died in 2021, before LLMs made repair
feasible. The GitHub issues tell the story better than any market report:
"Weekly update failed: 2026-08-10", "Scraper Broke Again", "JAV Library Scraper
Broke". Thousands of silent zeros, every week.

The fix isn't a better scraper. It's a loop that notices, repairs, and proves.

---

*Comments I'd genuinely like:*
- *If you run scrapers in production — how do you find out about breakage today?*
- *For the "data changed too" case, is LLM-propose + browser-verify the right shape, or is there something dumber that works?*
