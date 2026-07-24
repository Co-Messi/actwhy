# REVIEW.md — Pre-launch independent review

Before publishing, actwhy went through an independent multi-reviewer audit
across ten dimensions (product, architecture, security/dependencies, UX &
accessibility, test quality, documentation accuracy, SEO, repository
presentation, clean-environment install, launch assumptions). Every serious
finding was adversarially re-verified by a second reviewer attempting to
reproduce it before being accepted. This file records what was found, what
was fixed, and what remains — honestly.

## Serious findings — all fixed

| # | Finding (verified by reproduction) | Fix |
|---|---|---|
| 1 | A single malformed filter pattern (e.g. `paths: ['src/[']`) threw out of the evaluator and crashed the entire run — every other workflow lost its verdict | Pattern-compilation failures now degrade to a per-workflow `invalid workflow` verdict quoting the error; the rest of the run is unaffected |
| 2 | The playground's install section claimed the CLI could read "YAML on stdin" — no stdin handling exists | Claim removed (stdin support is tracked as a starter issue) |
| 3 | The most common stranger flow — running `actwhy` on a branch in sync with its upstream — produced a false "NOTHING fires" from an empty changed-file set | In-sync branches now simulate the last commit's push, with an explicit header label saying so |
| 4 | Site footer and JSON-LD pointed at an npm package page that 404s pre-publish | Repointed to the GitHub repository until the npm release is live |
| 5 | The social-preview image had overlapping, unreadable text (font-metric assumptions) | Layout rebuilt with fixed columns and end-anchored badges; re-rendered and visually verified |
| 6 | A launch-copy draft overstated provenance ("filter semantics are GitHub's code" — the filter-pattern engine is actwhy's own implementation of GitHub's documented grammar) | Corrected; the precise split (GitHub's libraries for parsing/expressions, actwhy's verified engine for filter patterns) is stated everywhere |
| 7 | Quantifiers after star atoms (`*+`, `**+`) compiled to nested regex quantifiers — a catastrophic-backtracking risk on hostile patterns | Star atoms now absorb a following quantifier (language-equivalent, linear-time) |
| 8 | The headline fidelity claim said "25/25" but the recorded artifact contains 24 runs | Restated precisely: 24 recorded runs predicted exactly, no false fires among the other ~130 workflow×event combinations, 3/3 job-level decisions |

## Meaningful improvements applied (selection)

- Global flags are accepted before the subcommand (`actwhy -C repo push`).
- `--base` documented as optional with its real default (was "Required").
- Comparison table extended with `wrkflw` and an explicit note on `act -n`/`-l`.
- `docs/limitations.md` examples corrected (job-level `secrets` is a GitHub
  parse error; `--event` fills `github.event.*` only — it cannot supply
  `secrets`/`vars`/`needs` outputs, by design).
- Playground accessibility: arrow-key tab navigation, screen-reader
  announcements scoped to a one-line summary instead of re-reading the whole
  tree, keyword-bearing section headings.
- Dependency license notices preserved in both shipped bundles;
  `@actions/*` versions pinned exactly.
- The live-fidelity data was turned into a runnable regression test
  (`test/golden-live.test.ts`) so the engine can never silently diverge from
  recorded real-GitHub behavior.
- Internal planning documents removed from the public tree and history.

## Known limitations that remain (accepted for v0.1)

- Only `push`, `pull_request`, and `pull_request_target` are *evaluated*;
  other events are honestly classified, never guessed
  (see [docs/limitations.md](docs/limitations.md)).
- Verdicts assume runs succeed ("happy path"); `failure()`-gated jobs are
  labelled as such rather than simulated.
- `--event` resolves payload unknowns only; `secrets`/`vars`/`needs` outputs
  stay `UNKNOWN` by design.
- Step-level `env:` is not evaluated; matrix-dependent step conditions
  report `UNKNOWN`.
- GitHub skips paths filters on pushes touching >1000 files; actwhy does not
  model that edge (documented).
- The web playground share-link format has no versioning guarantee yet.

Fidelity disputes are P1 bugs — file a
[fidelity report](.github/ISSUE_TEMPLATE/fidelity_report.yml).
