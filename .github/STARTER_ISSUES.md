# Starter issues

Eight issues to file after publishing, to give first-time contributors clear entry points. Each has a title, labels, and a ready-to-paste body. Labels assume the standard set plus area labels (`area:docs`, `area:core`, `area:cli`, `area:web`, `area:ci`).

---

## 1. Add more worked examples to the playground

**Labels:** `good first issue`, `area:web`, `documentation`

**Body:**

The [playground](https://actwhy.vercel.app) ships with a couple of preset workflows. Adding a small gallery of real-world examples would make the "aha" faster for first-time visitors.

Suggested presets, each demonstrating one verdict clearly:

- A `paths`-filtered monorepo CI that a docs-only change skips.
- A deploy workflow gated on `branches: [main]` that a feature branch misses (the "nothing fires" case).
- A workflow with the always-true `if: ${{ github.ref }} == '…'` footgun, so the warning shows.
- A job gated on `secrets.*` that resolves to `UNKNOWN`.

Add them as selectable presets in the playground UI. No core changes needed — this is data plus a dropdown.

---

## 2. Evaluate `schedule` triggers with next-fire times

**Labels:** `help wanted`, `area:core`, `enhancement`

**Body:**

Today `schedule` is classified as "cron only" but not evaluated. We should parse the cron expression and, given a reference time, report whether and when the workflow next fires.

Scope:

- Parse the `cron:` entries under `on.schedule`.
- Compute the next fire time(s) relative to "now" (or a `--now` override for reproducibility).
- Surface it in the verdict, e.g. *"scheduled — next fire 2026-07-25 00:00 UTC"*.

Fidelity notes to respect: GitHub schedules run in UTC, only on the default branch, and can be delayed under load — the output should describe the *scheduled* time honestly, not promise exact execution. Cite GitHub's schedule docs in the PR.

---

## 3. Add a `--diff ref..ref` mode

**Labels:** `help wanted`, `area:cli`, `enhancement`

**Body:**

Currently actwhy infers changed files from the working tree versus upstream. A `--diff ref..ref` flag would let users simulate an arbitrary range — for example what a merge, a rebase, or a specific PR's diff would trigger.

Scope:

- Accept `--diff main..feature` (and the two-dot / three-dot forms) on the `push` and `pr` subcommands.
- Resolve the changed-file list from `git diff --name-only <range>`.
- Fall back cleanly (with a clear message) when the refs do not exist locally.

This is mostly a `src/cli/` change; the core already accepts a file list.

---

## 4. Evaluate reusable workflows (`workflow_call`)

**Labels:** `help wanted`, `area:core`, `enhancement`

**Body:**

`workflow_call` workflows are currently classified but not evaluated. A calling workflow that `uses:` a reusable workflow should have that call expanded so its jobs appear in the verdict tree.

Scope:

- Detect `jobs.<id>.uses:` pointing at a local reusable workflow.
- Parse the called workflow and evaluate its jobs in the caller's context, passing `with:` inputs through.
- Represent the nesting in both the CLI tree and the report model.

Start with **local** reusable workflows (same repo, `./.github/workflows/x.yml`); remote `owner/repo/.github/workflows/x.yml@ref` can be a follow-up (it needs network or a checkout, which conflicts with the zero-network guarantee — discuss in the issue first).

---

## 5. Support `merge_group` triggers

**Labels:** `help wanted`, `area:core`, `enhancement`

**Body:**

Merge queues are increasingly common, and `merge_group` is currently classified but not evaluated. We should evaluate whether a workflow fires for a merge-group event, including any `branches` filter on the trigger.

Scope:

- Add a `merge_group` event spec to the core model.
- Evaluate the `on.merge_group` filters.
- Add fixtures based on real merge-queue runs, cited in the PR.

Good pairing with the fidelity corpus work in issue #6.

---

## 6. Expand the filter-pattern compliance corpus against real GitHub runs

**Labels:** `good first issue`, `area:core`, `testing`

**Body:**

The filter-pattern engine is the highest-fidelity part of actwhy, and the compliance corpus is how we keep it honest. We want more cases — especially the ones naive matchers get wrong.

High-value additions:

- `?` (zero or one of the **preceding** character) and `+` (one or more of the **preceding** character) — confirm they are *not* treated as wildcards.
- `!` negation ordering, where a later negation overrides an earlier match.
- Character classes `[…]` combined with `*` / `**`.
- `tags` versus `branches` behavior with `/`-containing patterns.

For each case, cite the source: GitHub's filter-pattern docs, or a real run you reproduced. See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-filter-semantics-test).

---

## 7. Render a `needs:` DAG as an ASCII graph

**Labels:** `good first issue`, `area:cli`, `enhancement`

**Body:**

When a job is skipped because a dependency was skipped, it would help to *see* the `needs:` graph. Add an optional ASCII rendering of the job DAG to the CLI output (perhaps behind a `--graph` flag) so the propagation is visible.

Scope:

- Build a small ASCII/box-drawing renderer for the job dependency graph.
- Annotate each node with its verdict (fires / skipped / unknown).
- Keep it readable for the common small-DAG case; large graphs can degrade gracefully.

The core already exposes `needs` on each `JobVerdict`, so this is a rendering-only task in `src/cli/`.

---

## 8. Add a Windows and macOS smoke job to CI

**Labels:** `good first issue`, `area:ci`

**Body:**

CI currently runs on Linux. Because actwhy shells out to `git` and does path handling, a lightweight smoke job on `windows-latest` and `macos-latest` would catch platform-specific breakage (path separators, line endings, `git` availability) early.

Scope:

- Add a matrix leg (or a separate job) for `windows-latest` and `macos-latest`.
- Run `npm run build` and a minimal `actwhy` invocation against a fixture repo.
- Keep it fast — this is a smoke test, not the full suite.
