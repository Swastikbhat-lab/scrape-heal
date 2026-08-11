# Growth Marketer — 30-day free launch plan (zero ad spend)

**Persona: Growth Marketer.** Bootstrapped budgets only. Every channel below costs
time, not money. The compounding ones (content, community, SEO) get priority; the
one-shot ones (Show HN, Reddit) get fired first because they're time-sensitive.

## The honest math

This is a free dev tool. Free dev tools grow in one of two ways:
- **A spike**: Show HN / Reddit front page → a burst of stars and curiosity.
- **A trickle**: people searching "selector broke", "scraper stopped working",
  "self-healing scraper" find it months later.

The plan does the spike first, then builds the trickle. Trickle without spike is
invisible; spike without trickle is a one-day wonder.

## Free channels, ranked

| # | Channel | Cost | Why | When |
|---|---|---|---|---|
| 1 | **Show HN** | 0 | Highest-leverage spike for dev tools | Week 1, Tue/Wed, ~9am US ET |
| 2 | **Reddit — r/webscraping** | 0 | 100% target audience, tiny but real | Week 1, day after HN |
| 3 | **Reddit — r/selfhosted, r/Python, r/DataHoarder** | 0 | Adjacent audiences, DataHoarder loves scraping | Week 1–2 |
| 4 | **Dev.to / Hashnode** | 0 | The technical post, cross-posted; permanent SEO trickle | Week 2 |
| 5 | **X thread** | 0 | The 3am cron story; reply to every reply | Week 2 |
| 6 | **Discord/Slack communities** | 0 | Web-scraping discords, indie hacker servers — *share, don't pitch* | Week 2 |
| 7 | **Question answering** (Reddit search, Stack Overflow, HN search) | 0 | Every "scraper broke" thread is a customer with a live problem | Week 3, ongoing |
| 8 | **Awesome lists** | 0 | Permanent SEO backlink; low effort, some lists take PRs | Week 3 |
| 9 | **Indie Hackers** | 0 | The build-in-public crowd; they *are* the audience | Week 3 |
| 10 | **Product Hunt** | 0 (free tier) | Only after HN/Reddit show traction — a PH launch with zero interest reads as desperation | Week 4 |

## The 30-day calendar

**Week 1 — fire the spike**
- [ ] Record a demo GIF of `npm run demo` (the single best asset; do this first)
- [ ] Post Show HN (draft in `show-hn.md`) — Tue or Wed, US morning
- [ ] Next day: r/webscraping (draft in `reddit.md`), framed as a question
- [ ] Reply to **every** comment within a few hours. The comment section is the product.
- [ ] Watch stars. If HN gets >30 comments, cross-post the story to X same week.

**Week 2 — build the trickle**
- [ ] Publish the technical post (in `cto-technical-post.md`) on Dev.to + Hashnode
- [ ] Post the X thread (draft in `x-thread.md`)
- [ ] Share in 2–3 scraping/automation Discords: "built this, would love feedback" —
      never a bare link
- [ ] r/selfhosted + r/Python posts, reworded per subreddit

**Week 3 — harvest demand**
- [ ] Search Reddit/HN/Twitter for "scraper broke", "selector stopped working",
      "scraping stopped" — answer people, mention the tool only when it fits
- [ ] Submit to awesome lists: `awesome-scraping`, `awesome-web-scraping`,
      `awesome-selfhosted` (PRs), `awesome-playwright`
- [ ] Post on Indie Hackers: the build story, demo, ask "who's had a scraper break?"

**Week 4 — measure, don't panic**
- [ ] Record: stars, Show HN comments, Reddit comments, demo runs (add a badge if you can count clicks)
- [ ] Collect every "this happened to me" story — those are the case studies
- [ ] Only if traction exists: Product Hunt launch + one more X thread
- [ ] Pick the one channel that outperformed and double down on it in month 2

## The rule that beats everything

**Reply to every comment, everywhere, forever.** Ten engaged commenters are worth
more than a thousand passive stars — they're the people who will file the issues,
request the features, and post about it themselves.

## Free tooling (no investment needed)

- Demo recording: OBS is free; or `npx playwright video` / a screencast tool
- Dev.to + Hashnode: free, built-in audience
- Awesome-list submissions: free PRs
- Analytics for stars: GitHub API, or `stargazers` scripts
- Link tracking: GitHub badges (shields.io) if you add a click-counter URL
