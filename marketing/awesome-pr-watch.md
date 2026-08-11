# Awesome-list PR watch

Two open PRs, tracking status and pre-drafting replies to likely maintainer
questions. **Update this doc the moment anything lands** — replies within a day,
polite and fact-first, never defensive.

## Status (checked 2026-08-10)

| PR | Repo | State | Activity |
|----|------|-------|----------|
| [#17](https://github.com/Germey/AwesomeWebScraping/pull/17) | Germey/AwesomeWebScraping (JavaScript list) | OPEN | none — no comments, no reviews |
| [#19](https://github.com/h4ckf0r0day/awesome-ai-web-scraping/pull/19) | h4ckf0r0day/awesome-ai-web-scraping (AI list) | OPEN | none — no comments, no reviews |

## How to re-check (30 seconds)

```bash
gh pr view 17 --repo Germey/AwesomeWebScraping --json state,comments,reviews
gh pr view 19 --repo h4ckf0r0day/awesome-ai-web-scraping --json state,comments,reviews
```

Also watch the repo's issue tracker — some maintainers comment on the PR *and*
open a note. Both forks live in `FreeBuff_Projects/prs/` if a rebase or edit is
ever needed.

## Facts both PRs stand on (verify before replying)

- MIT licensed, TypeScript, no deps beyond Playwright; demo runs in three
  commands (`npm install`, `npx playwright install chromium`, `npm run demo`).
- The loop: detect output-shape drift against the last good run → repair by
  finding elements that still contain the known-good data → ship only after
  re-verifying extraction on the live page. Watchdog alerts on an unhealable
  red run and exits non-zero for schedulers.
- Works with any scraper via the rows contract (JSON / JSON Lines / CSV), not
  just Playwright — relevant if a maintainer asks "is this only for one
  framework?".

---

## Reply bank — likely maintainer questions

### Germey (#17, general JavaScript list)

**Q: "Too new / why should this be listed?"**
> Fair question — it's a fresh project. The case for it: MIT, no deps beyond
> Playwright, and the demo runs in three commands, so it's immediately
> tryable. It targets a gap the list doesn't currently cover — the maintenance
> side of scraping (detect breakage + repair selectors), not another fetch
> layer. If you'd rather wait until it has more history, no hard feelings —
> happy to close it and come back later.

**Q: "Can you tighten the description?"**
> Sure — one line: "Self-healing scraper loop: detects when a site's redesign
> breaks your selectors, repairs them, and only ships verified fixes." Use
> that verbatim or tell me the house format and I'll match it.

**Q: "This overlaps with X (a listed tool)"**
> The distinction is verification: most tools in that space *propose* fixes
> (or just fetch); this loop *refuses to ship* a repair unless re-extracting
> the live page reproduces the last good run's data. Happy to point at the
> specific comparison if useful.

### h4ckf0r0day (#19, AI web-scraping list)

**Q: "This isn't AI-powered — why is it in an AI list?"** *(most likely question)*
> Honest answer: today it's deterministic — no LLM in the loop, and that's
> deliberate, because text-matching is free and verifiable. It belongs here
> for two reasons: (1) the people it serves are AI pipelines — every scraper
> feeding an LLM/RAG ingestion breaks silently on redesign, and this is the
> maintenance layer for exactly that; (2) the architecture is LLM-ready by
> design: proposal (find new selectors) is where an LLM plugs in for cases
> where the data itself changed, and verification stays deterministic. If the
> list is strictly for AI-*powered* scraping tools as written, I'll withdraw
> the PR — no friction either way.

**Q: "LLM repair is just a roadmap item?"**
> Correct, and the PR says so. The deterministic loop ships today; LLM-assisted
> proposal is the stated next step, with the browser still doing verification.
> If you'd rather list only shipped AI features, that's a fair bar — happy to
> close and resubmit when the LLM step lands.

**Q: "Where does it fit? Frameworks & Libraries?"**
> The loop is a library you embed in your own scraper (one config file or a
> few lines of API), which is why Frameworks & Libraries fit. If another
> section reads better for your structure, tell me the target and I'll move it.

---

## If a maintainer asks for something we can't do

- **"Closed PR for rules violation"** — don't argue; ask what would make it
  acceptable and whether a resubmission later is welcome.
- **"Needs tests"** — we have typecheck + three demo paths; a real test suite
  is a genuine next step. Offer a timeline, don't promise a date.
- **"Needs a license file / badges"** — already done (MIT, badges in README).

## Log

- 2026-08-10: created. Both PRs OPEN, zero maintainer activity.
