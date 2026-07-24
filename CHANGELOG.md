# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- See the [roadmap](README.md#roadmap) for planned work: `schedule` evaluation, `workflow_call` graph expansion, `--diff ref..ref`, and CI annotation mode.

## [0.1.0] - 2026-07-24

Initial release.

### Added

- **Three-valued trigger simulation** — every workflow resolves to `FIRES`, `SKIPPED` (with the exact failing filter quoted in plain English), or `UNKNOWN` (naming the runtime-only value it needs and how to supply it). actwhy never guesses.
- **`push` and `pull_request` / `pull_request_target` evaluation** of `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore`, and activity `types` filters.
- **GitHub's exact filter-pattern semantics**, built on GitHub's MIT-licensed `@actions/workflow-parser` and `@actions/expressions`, including the regex-style `?` and `+` quantifiers and `!` negation ordering.
- **Three-valued (Kleene) expression evaluation** for workflow- and job-level `if:`, so unknowns propagate only when they change the outcome (`<unknown> && false` stays a decisive `SKIPPED`).
- **`needs:` DAG propagation** with `always()` / `failure()` / `success()` handling; `failure()`-gated jobs are shown as "only runs when a needed job fails".
- **Static matrix expansion and counting**; dynamic (`fromJSON`) matrices are reported as `unknown`.
- **Always-true `if:` footgun detection** — warns on mixed templates such as `if: ${{ github.ref }} == 'refs/heads/main'`.
- **Zero-config git inference** — `actwhy` with no arguments infers the current branch and outgoing changed files; `actwhy pr --base main` simulates a pull request.
- **`--json` output** for scripting and **`--steps`** for step-level detail.
- **Web playground** running the same core in the browser, fully static and client-side.
- **Fully local operation** — zero network calls, zero telemetry, never reads secrets.

### Known limitations

- `schedule`, `merge_group`, `workflow_run`, and `workflow_call` are classified but not evaluated.
- Concurrency is not modeled; step-level `env:` is not evaluated; verdicts assume runs succeed.
- The >1,000-changed-files paths-filter skip that GitHub performs is not modeled.

See [docs/limitations.md](docs/limitations.md) for the full list and what actwhy reports in each case.

[Unreleased]: https://github.com/Co-Messi/actwhy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Co-Messi/actwhy/releases/tag/v0.1.0
