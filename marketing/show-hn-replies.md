# Show HN — reply bank (first ten comments)

Pre-drafted answers to the comment types a Show HN like this actually attracts.
**Rules before posting each one:** read the real comment, keep the reply
standalone-answer-first, cut anything that doesn't apply, keep it under ~8
sentences, and only keep the closing question if it's natural. Never paste a
template verbatim — HN commenters can smell it.

Track who replied and what they asked in `marketing/outreach-tracker.md`
(once it exists) — engaged commenters are the first users.

---

## 1. "I built something similar / this is just X / been done before"

> Totally fair — the pieces have all existed separately for years. What I found
> missing was the loop that ties them: validation against a baseline, repair by
> searching for the known-good values, and a verification gate that blocks the
> repair unless re-extraction reproduces the last good run. The third part is
> the one I never saw productized — most "auto-repair" I've found ships the
> candidate and hopes.
>
> What's your approach to the verification side? That's the part I'd genuinely
> steal ideas for.

## 2. "This breaks the moment the site adds Cloudflare/anti-bot/WAF"

> Yes — and that's a deliberate line in the sand. Anti-bot is the *loud*
> failure: you get a 403 or a challenge page and you know immediately. The tool
> targets the *silent* failure — markup changed, 200 OK, empty output, found
> out a week later. Different problem, different fix.
>
> If a site starts blocking, the loop treats it as a scraper failure (it
> refuses to "heal" a 403 into a selector), alerts, and exits non-zero so the
> scheduler sees it. I'd rather fail loudly than paper over a block.

## 3. "Why not just use an LLM to fix the selectors?"

> The LLM is the *proposal* half — and it's a good one, especially when the
> data itself changed. The part I care about is keeping proposal separate from
> verification. In my loop the browser re-extracts with the candidate and the
> repair ships only if the result matches the last good run — an LLM can be
> confidently wrong, and a verifier that can't be fooled by confidence is the
> safety net.
>
> Plan is to bolt an LLM onto the proposal step later and keep the verify step
> exactly as dumb as it is now.

## 4. "What happens when the data legitimately changes? Won't it re-break / flag everything?"

> Healthy runs refresh the baseline every cycle, so legit content changes get
> absorbed, not flagged. A repair only triggers when the *shape* breaks:
> item count collapses below a threshold, known identity values vanish, fields
> come back empty. New products arriving, prices changing — that's a normal
> run, baseline updates, no alarm.
>
> The hard case is a redesign that also changes the values — then there's
> nothing to anchor a repair to, and the loop says so instead of guessing.

## 5. "It's a PoC — why would I trust this in production?"

> You shouldn't yet, honestly — that's why it refuses to ship unverified
> repairs and why the alert path exists. The design goal was: the worst it can
> do is *not fix it and tell you loudly*, never silently break your data.
> The exit code contract (0 = healthy/healed, 1 = red) is there so a cron or CI
> pipeline fails before your spreadsheet does.
>
> For production I'd want the ledger of previously-proven selectors and
> pluggable validators — both on the roadmap, both open issues if you want to
> shape them.

## 6. "This only works for Playwright-style scrapers"

> The loop's contract with your scraper is one sentence: give me the rows. It
> validates rows, remembers the last good ones, and the browser only enters the
> loop where it's irreplaceable — finding and *verifying* a repair. Any scraper
> that can print JSON, JSON Lines, or CSV (Scrapy, Puppeteer, bs4, a cron dump)
> can be watched via `--rows-from "<cmd>"` or `--rows-file <path>`; on a
> verified repair it writes the new selectors back to a config file the scraper
> reads on its next run.
>
> The README has copy-paste recipes for Scrapy, Puppeteer, and a legacy CSV
> dump in docs/INTEGRATIONS.md.

## 7. "What about login walls / JS-heavy pages?"

> The browser is in the loop, so anything Playwright can reach is in scope —
> including JS-rendered pages and logged-in sessions (you'd keep the session
> context, the loop just reads rows). The one thing I wouldn't build is
> bypassing auth/anti-bot deliberately; the tool is for the 99% case where the
> data is public and the markup just moved.

## 8. "Is this legal / doesn't this violate ToS?"

> The tool doesn't bypass anything — it reads public pages with a real browser,
> same as the scraper you already run. What it adds is detecting when the page
> changes and repairing the selectors, which doesn't change the request pattern
> meaningfully. Same obligations as any scraper: respect robots, rate limits,
> and the site's terms. If a site blocks you, it alerts and stops trying.

## 9. "A cron job that validates output would do the same thing"

> Honestly, for detection — yes, and the validation logic is simple enough to
> write in an afternoon. What I'd push back on is the repair half: once you
> know it's broken, someone still has to inspect the page, find the new
> selectors, and re-test. The loop does that part against the last good run as
> ground truth, and only ships when re-extraction matches.
>
> If you already have validation that works, I'd love to see how you handle the
> post-breakage step — that's the part I built this for.

## 10. "How is this different from Goldseam?"

> Same problem, different target — and both of us landed on verification, just
> against different ground truth. Goldseam heals *Cypress test selectors*: a
> six-rung ladder (offline triage/propose/resolve/oracle judge + reruns
> against the app) verifies each repair, and the repair space is restricted to
> selector strings so assertions can never be weakened. scrape-heal heals
> *extraction selectors* for scrapers: verification is re-extracting the live
> page and requiring the same data as the last good run — the data is the
> oracle, not the test.
>
> The interesting tradeoff: they prevent weakened repairs by restricting what
> can change (selector strings only); I prevent them by requiring data
> equivalence (the extracted rows must match). Different mechanisms, same
> instinct — and both treat "give up honestly" as a real outcome rather than
> hiding it.

---

## Bonus: a genuinely curious question that fits the post's own questions

If someone engages with either of the two questions from the post ("data
changes, not just markup" or "how do you find out about breakage"), reply with
a real answer of your own and a concrete example, not a sales line. The
question thread is where the product gets better.

---

## The GIF is your reply asset

Whenever a comment asks "can I see it?", "any demo?", or "what does this
actually do?", lead with the GIF — it's the pitch that reads itself:

> Sure — 24-second loop of the whole story: healthy run, silent redesign,
> breakage detected, selectors healed, verified on the live page:
> https://github.com/Swastikbhat-lab/scrape-heal/blob/main/docs/demo.gif
>
> (The repo README starts with the same animation, so clicking through
> re-plays it without hunting.)

Same URL works in every comment — one asset, zero typing.

