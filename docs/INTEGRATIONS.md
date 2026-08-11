# Integrating scrape-heal with your scraper

scrape-heal doesn't care how you scrape. It only needs one thing from you:
**rows**. JSON, JSON Lines, or CSV — on stdout or in a file. It validates the
rows against the last good run, and when they break it finds the new selectors
in a browser and proves the repair before shipping it.

Three recipes below, copy-paste ready. All of them work with the same loop:

```
your scraper ──rows──▶ scrape-heal ──validates, heals, verifies──▶ repaired
                                                                    selectors
                                                                    (written back)
```

---

## Recipe 1 — a Scrapy spider

Scrapy's stdout feed is **JSON Lines** (one JSON object per line), which
scrape-heal parses natively.

**`my_spider.py`** — a normal spider, nothing scrape-heal-specific:

```python
import scrapy

class ProductsSpider(scrapy.Spider):
    name = "products"
    start_urls = ["https://example.com/products"]

    def parse(self, response):
        for card in response.css(".product-card"):
            yield {
                "name": card.css(".name::text").get(),
                "price": card.css(".price::text").get(),
            }
```

**`scraper.config.json`** — point scrape-heal at it:

```jsonc
{
  "url": "https://example.com/products",   // browser re-measures the page to heal
  "items": ".product-card",                // what a row container looks like
  "fields": { "name": ".name", "price": ".price" },
  "identityField": "name",
  "minItems": 4,
  "rowsFrom": "scrapy runspider my_spider.py -o -",
  "writeConfig": "scraper.config.json"     // repaired selectors land here
}
```

Then just:

```bash
npm run watch
```

When the site redesigns, scrape-heal detects it from the spider's rows, heals
the selectors in a real browser, verifies them, and writes them back to
`scraper.config.json`. To pick the repaired selectors up inside the spider:

```python
import json

with open("scraper.config.json") as f:
    cfg = json.load(f)

class ProductsSpider(scrapy.Spider):
    name = "products"
    start_urls = [cfg["url"]]

    def parse(self, response):
        for card in response.css(cfg["items"]):
            row = {}
            for f in cfg["fields"]:
                row[f["name"]] = card.css(f["selector"] + "::text").get()
            yield row
```

## Recipe 2 — a Puppeteer (or plain Node) script

Anything that prints a JSON array to stdout works. **`my_puppeteer.mjs`**:

```js
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('https://example.com/products');

const rows = await page.$$eval('.product-card', (cards) =>
  cards.map((card) => ({
    name: card.querySelector('.name')?.textContent?.trim(),
    price: card.querySelector('.price')?.textContent?.trim(),
  })),
);

console.log(JSON.stringify(rows)); // the only contract: rows on stdout
await browser.close();
```

**`scraper.config.json`**:

```jsonc
{
  "url": "https://example.com/products",
  "items": ".product-card",
  "fields": { "name": ".name", "price": ".price" },
  "identityField": "name",
  "minItems": 4,
  "rowsFrom": "node my_puppeteer.mjs",
  "writeConfig": "scraper.config.json"
}
```

Run with `npm run watch`. Your script never changes — on a repair, read the new
selectors from `scraper.config.json` on the next run.

## Recipe 3 — a legacy cron dump (no code changes at all)

Already have a scraper that dumps results on a schedule? Watch its output file.
Your scraper doesn't even need to run from scrape-heal:

```bash
# crontab — your existing scraper, unchanged
0 3 * * * cd /home/you/products && ./my_legacy_scraper > data/rows.csv
```

**`scraper.config.json`**:

```jsonc
{
  "url": "https://example.com/products",
  "items": ".product-card",
  "fields": { "name": ".name", "price": ".price" },
  "identityField": "name",
  "minItems": 4,
  "rowsFile": "data/rows.csv",          // watch the dump, not a command
  "writeConfig": "scraper.config.json"
}
```

`npm run watch` polls `data/rows.csv` each cycle. The moment the dump starts
coming back empty or misshapen, the loop notices — and if it can, heals.

---

## The ground rules (same for every recipe)

- **`url` is only needed for self-healing.** The browser has to re-measure the
  live page to find and verify a repair. Without it, scrape-heal is a plain
  detector: it validates and alerts, and refuses to guess at repairs.
- **A scraper crash is never "healed".** If your command exits non-zero or
  prints nothing parseable, that's reported as a scraper failure, not a site
  change — the loop won't repair your scraper's own bugs.
- **Nothing ships unverified.** A repaired config only lands in
  `writeConfig` if re-extracting the live page reproduces the last good run's
  data. Otherwise you get a loud alert and the old config stays untouched.
- **Rows format:** a JSON array, JSON Lines (one `{…}` per line), or CSV with a
  header row. Empty output is treated as zero rows, which breaks the
  `minItems` check — which is exactly the silent failure this tool exists for.
