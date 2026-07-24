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
| 3 | The most common stranger flow — running `actwhy` on a branch in sync with its upstream — was ambiguous | In-sync branches now report a truthful empty outgoing set with an explicit header label; already-pushed files are never substituted |
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
- GitHub's >1,000-commit/diff-timeout fallback and 300-file path-filter window
  are not modeled (documented).
- The web playground share-link format has no versioning guarantee yet.

Fidelity disputes are P1 bugs — file a
[fidelity report](.github/ISSUE_TEMPLATE/fidelity_report.yml).

## Second-pass adversarial review (post-launch, 2026-07-24)

A fresh CTO-level adversarial review (`.roast/REPORT-latest.md`) went deeper on
the untrusted-input boundary and found two real defects the first pass missed,
plus several improvements. All were fixed and covered by regression tests.

| Severity | Finding | Fix |
|---|---|---|
| **Critical** | The earlier ReDoS fix only special-cased star atoms; `branches: ['a++']` still compiled to a nested-quantifier `RegExp` and hung the process for minutes on a ~30-char value (uncatchable — a hang, not a throw). | Replaced the RegExp compiler with a **linear-time Thompson-NFA matcher**. Backtracking is impossible by construction; the reviewer's 120 s hang is now ~2 ms. |
| **High** | Attacker-controlled workflow text (filter patterns, branch names, commit messages, parser errors) was written to the terminal verbatim — a crafted workflow could inject ANSI escapes to forge a green `FIRES` line. | `render.ts` now strips all C0/C1 control chars and `ESC` from every attacker-derived string before output. Verified: zero `0x1b` bytes reach stdout for a malicious workflow. |
| Medium | A static matrix of 257–4096 legs was reported as firing; GitHub caps matrices at 256 jobs (and fails the run). | Report the job as a `matrix-over-limit` error and count zero firing variants. |
| Medium | `paths` + `paths-ignore` on one event silently dropped `paths-ignore`. | Report mutually exclusive include/ignore pairs as invalid instead of inventing precedence. |
| Medium | The CLI always exited `0`, so it couldn't gate CI. | Added `--exit-code` (3 = invalid workflow, 4 = nothing fires). |
| Low | `--event` JSON was unvalidated/unbounded; `__proto__` keys merged; Node < 20 crashed cryptically; git base ref could be a flag; `workflowName()` was a dead stub; CI actions pinned by tag. | Validated/size-capped `--event` + forbidden-key filter; clear Node-version guard; `--end-of-options` on git diffs; wired `name:`; SHA-pinned CI actions. |

After these fixes: `npx tsc --noEmit` clean, full suite green (including new
`test/redos.test.ts`, `test/render-injection.test.ts`, `test/roast-fixes.test.ts`),
build + web build succeed.
