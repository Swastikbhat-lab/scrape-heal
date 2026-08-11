## What this does

<!-- One or two sentences: the behavior change, not the file list. -->

## Why

<!-- The problem this solves. Link the issue if there is one (Fixes #…). -->

## Design rules check

- [ ] **Verify gate intact** — any new or changed repair path re-extracts against
      the live page before shipping, and refuses loudly (exit 1, nothing modified)
      when verification fails.
- [ ] **No unverified claims** — no production-readiness, no anti-bot, no "AI" where
      "a model proposes, the browser verifies" is the truth.
- [ ] **No new runtime dependencies** without explaining why in the description.

## Checks

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (and new behavior has a test — fixtures preferred over live sites)
- [ ] README updated where user-facing (and finished work moved out of
      "What's next (honestly)")
- [ ] If the demo story changed, `npm run make:gifs` re-ran so README/launch GIFs don't drift

## Anything else

<!-- What you're unsure about, what a reviewer should look at first, what you decided not to do. -->
