# Reddit drafts

## r/webscraping — the main post

**Title:**
How do you all deal with selectors silently breaking? I made a tool that fixes them itself

**Body:**

Genuine question first: when a site you scrape redesigns and your selectors die,
how do you find out? Because in my experience it's always the empty-spreadsheet
method — the data just stops showing up and you notice days later.

I got tired of it and built a loop that fixes it:

1. Every run validates the extraction — enough items, no empty fields, every value
   from the last good run still present.
2. When it breaks, it looks at the live page for elements that still contain the
   known-good data (e.g. the product titles it extracted last week) and derives new
   selectors from them.
3. The load-bearing step: it re-runs the repaired config against the live page and
   only ships it if the same items come out. If verification fails, nothing ships.

Demo is 3 commands and shows a full break-and-heal cycle against a fake storefront:

```
npm install && npx playwright install chromium && npm run demo
```

https://github.com/Swastikbhat-lab/scrape-heal

It's a PoC (~300 lines) so I'm aware the "known data" trick has limits — mainly when
the data itself changes, not just the markup. For that I'm assuming LLM-assisted
repair is the answer, but happy to be told there's a dumber approach that works.

So: what do you currently do when selectors break? And does "repair + verify" match
how you'd want it to work, or is the alert-only version more your speed?

## r/selfhosted — the follow-up (shorter)

**Title:**
Made a self-healing web scraper — it repairs its own selectors after site redesigns

**Body:**

Most of my cron jobs are scrapers and most of them have silently broken at some
point because the site renamed a class. Built a small loop that detects that, finds
the new selectors by matching the known-good data on the live page, and only ships
the fix after re-verifying the extraction. Runs fully local, ~300 lines, MIT.

```
npm install && npx playwright install chromium && npm run demo
```

https://github.com/Swastikbhat-lab/scrape-heal

Next on my list is a watchdog mode (run on a schedule, alert the moment a run goes
red). Thoughts welcome.
