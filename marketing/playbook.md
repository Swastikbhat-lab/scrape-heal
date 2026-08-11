# The casual launch playbook

Goal: get this in front of scraper-havers without sounding like a startup.
Nobody trusts launch language. Everyone trusts "here's a thing that annoyed me, so I made this."

## The core move

**Post the demo output, not the pitch.** The `npm run demo` transcript is the whole
story — healthy, broken, self-healed, identical data. Paste that, don't explain it.
A reader should go "oh, that's the thing that broke my scraper last month."

## Where to post (in order)

1. **Hacker News — "Show HN: ..."** — the single highest-leverage post for dev tools.
   Post on a weekday morning (US time), title = what it does, not what it is.
   The first few comments decide everything: reply to every single one, even "meh".
2. **Reddit — r/webscraping** (main one), then **r/selfhosted** and **r/Python**.
   r/webscraping is small but 100% your exact audience. Frame as a question:
   "how do you all deal with selectors breaking?" and mention you built a thing.
3. **X/Twitter** — one thread, 6 tweets, the demo as the middle. Reply to anyone
   who engages. Don't tweet it more than once.
4. **Product Hunt** — only after HN/Reddit get any traction. A PH launch with zero
   interest reads as desperation; with interest it's a formality.

## The rules of casual

- First person. "My cron job broke at 3am and I found out a week later" beats
  "Scraping pipelines face significant maintenance overhead."
- Show numbers (stars, comments) if you get them; never invent them.
- Ask a real question at the end ("does anyone actually solve this differently?").
  A real question gets real answers; a pitch gets silence.
- Reply to every comment within a few hours. The comment section is the product.
- Don't post the same text everywhere. Same story, different shape per platform.

## What NOT to do

- No "we", no "our mission", no "revolutionizing data extraction".
- No pinned tweet + LinkedIn manifesto combo.
- Don't delete negative comments. Answer them.
- Don't mention this was built with an AI agent unless someone asks. If asked, just say yes, cheerfully, and show the repo.

## When you get traction

- Add a real demo GIF (record `npm run demo`) — it's the single best README asset.
- Turn the "what's next" list into a public roadmap so people can argue about it.
- Collect the "my scraper broke" stories people tell you in comments — those are
  the case studies and the feature list.
