# Contributing to scrape-heal

Thanks for showing up. This is a deliberately small project — that's a feature, not
a bug. The whole loop fits in your head:

> **detect → heal → verify.** If the repair can't be verified on the live page, nothing ships.

## The two design rules

1. **Never ship an unverified repair.** Every repair path — text, LLM, ledger — must
   re-extract against the live page before it ships. A repair that skips this gate is
   not an improvement, it's a bug. A *failed* verification must refuse loudly, exit 1,
   and change nothing.
2. **Docs are honest or absent.** When a feature ships, move it out of "What's next
   (honestly)" into the README body. Never claim production readiness, never claim
   anti-bot capabilities, never say "AI" when you mean "a model proposes, the browser
   verifies." HN commenters and engineers both check.

## Setting up

```bash
npm install
npx playwright install chromium   # the end-to-end tests drive a real browser
npm run typecheck
npm test                          # 31 tests — should be green before you start
```

Node >= 20. No runtime dependencies beyond Playwright; keep it that way. If a feature
genuinely needs a dependency, say so in the PR — don't sneak one in.

## Where things live

```
src/
  scraper.ts     extract() / validate() / validateShape() — the detect half
  heal.ts        heal() — text pass first, LLM fallback, one verify gate
  llm.ts         structure skeleton + OpenAI-compatible proposal client
  validator.ts   loadValidator() — pluggable schema files
  watchdog.ts    the loop: extract → validate → ledger → heal → alert
  source.ts      the any-scraper contract: rows from a command, file, or Playwright
  config.ts      scraper.config.json parsing + template
  cli.ts         the CLI: flags, demo fixture server, mock LLM endpoint
  demo.ts        the 15-second story demo (npm run demo)
  demo-any.ts    same loop with a fetch+regex scraper (npm run demo:any)
fixture/         site-v1/v2/v3.html (the redesigns), regex-scraper.mjs, validator.js
test/            node:test suite — validate, parse, proposals, ledger, heal e2e
docs/            INTEGRATIONS.md (Scrapy/Puppeteer/cron recipes), demo GIFs
scripts/         GIF generators — re-run npm run make:gifs if a demo's story changes
```

## Making a change

1. **Add a test first.** `test/` is plain `node:test` through tsx — no new test
   framework. The end-to-end heal tests (`test/heal.test.ts`) start real fixture
   servers and a real browser; mirror that instead of inventing a new harness.
2. **Prefer fixtures over real sites.** The demos and tests run against
   `fixture/site-v1/v2/v3.html`. If your feature needs a new "site" scenario, add a
   fixture and a `--mutate-*` mode — never a live URL.
3. **Keep the gate intact.** If your change adds a new repair path, verify-then-ship
   applies to it too. The wrong-proposal refusal test is the template.
4. **Run everything:**

   ```bash
   npm run typecheck
   npm test
   npm run demo          # the story still reads correctly
   ```

5. **Update the docs that the change touches** — including moving finished work out
   of "What's next (honestly)" — and if the demo story changed, regenerate the GIFs
   (`npm run make:gifs`) so the README and the launch kit don't drift.

## Commit style

Short message, why-focused, one logical change per commit. If the change fixes an
issue, reference it. No "wip" commits on the main line.

## Releasing (maintainers)

A version bump is one command — CI does the rest:

```bash
npm version patch -m "v%s"   # or minor / major; tags vX.Y.Z automatically
git push && git push --tags
```

The `Release` workflow (`.github/workflows/release.yml`) runs the full gate
(typecheck + tests + build, plus a tag-must-match-version check) and then
`npm publish`. It needs an npm access token stored as the `NPM_TOKEN` repo
secret — add it once and releases stay one command away.

## Asking questions

Open an issue with the **Question** template — the maintainer answers fast, and
"how does X work?" questions have a habit of becoming documentation.
