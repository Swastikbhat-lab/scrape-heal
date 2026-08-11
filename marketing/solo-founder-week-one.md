# Solo Founder — Week One, actually doing it

**Persona: Solo Founder.** One person, finite hours, everything is a tradeoff.
This is the "what do I physically do this week" plan, not the strategy document.
Goal: **10 people say "this happened to me"** — that's the validation, not stars.

## The honest framing

The product is validated when strangers recognize their own pain in the demo.
Stars are vanity until then. So week one is one job, repeated: **get the demo in
front of people whose scraper has broken, and get them talking.** Features wait.
The watchdog can wait. Watchdog is the reward for evidence, not the evidence.

## The time budget (≈6–8 hours, spread out)

### Hour 1–2: make the demo effortless
- [ ] Record a ~30s demo GIF of `npm run demo` (this is your entire landing page)
- [ ] Make sure `npm install && npx playwright install chromium && npm run demo`
      works on a clean clone — it does, but verify by cloning it fresh
- [ ] Add the GIF to the README top (a GIF does the selling; the words just support it)

### Hour 2–3: fire the spike
- [ ] Post Show HN (Tue/Wed morning US time) — draft in `marketing/show-hn.md`
- [ ] Same evening: r/webscraping, framed as a question — draft in `marketing/reddit.md`

### Hour 3–4: the 10-user move (this is the actual job)
Find people with live breakage, not hypothetical interest:
- [ ] Reddit search: `site:reddit.com scraper broke`, `site:reddit.com "stopped working" scraper`,
      `site:reddit.com selector changed`
- [ ] HN search (hn.algolia.com): `scraper`, `selector`, `scraping stopped`
- [ ] Twitter/X search: `"my scraper broke"`, `"scraper stopped working"`
- [ ] For each live thread: answer their actual question first (help them, for free).
      Then, only if it fits naturally: "I built a thing that auto-repairs this — happy
      to show you." No link dumps. 10 real conversations, not 100 cold DMs.

### Hour 4–5: the trickle seed
- [ ] Publish the technical post (`marketing/cto-technical-post.md`) on Dev.to + Hashnode
- [ ] Post the X thread (`marketing/x-thread.md`) if the day had any engagement

### Hour 5–6: answer everything
- [ ] Every comment, everywhere, within hours. Not tomorrow. Hours.
- [ ] Anything negative: thank them, ask what they'd change. The comment section is the product.

### Hour 6–7: measure without self-deception
- [ ] Stars, HN/Reddit comment counts, how many "this happened to me" replies
- [ ] Write down the *stories* people told you — word for word. Those are the case studies.

### Hour 7–8 (only if the week worked): decide
- [ ] If 5+ strangers said "this happened to me": the idea is worth the next month.
      Next: demo GIF polish, watchdog mode, Product Hunt.
- [ ] If zero: you learned it cheaply. Talk to 10 more people, change the framing,
      or shelve it. Either way you didn't burn a month building the wrong thing.

## Scope-creep guard

Do NOT, this week:
- build watchdog mode
- write a Dockerfile
- "improve" the healer for edge cases you invented
- set up a blog
- rename the project

Every one of those feels productive. None of them produce a stranger saying
"my scraper broke and I found out a week later." That sentence is the product.

## The outreach script (for the 10-user move)

> Hey — saw your post about the scraper that stopped working. Real quick, since
> you're debugging it anyway: did the site change its markup, or did the data
> change too? I built a small tool that auto-detects the first case and repairs
> its own selectors — it remembers what the data looked like and re-verifies the
> fix on the live page before shipping it. Not selling anything, genuinely
> curious if the "repair + verify" shape matches how you'd want it to work:
> https://github.com/Swastikbhat-lab/scrape-heal

Note what it does: asks a real question, admits the limit, asks for *their* opinion.
That's the difference between a pitch and a conversation.
