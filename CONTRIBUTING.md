# Contributing to actwhy

Thanks for helping make actwhy more accurate. This is a small, fidelity-first project: the whole point is that a verdict you can trust is worth more than a fast one you can't. Contributions of every size are welcome — especially fidelity reports and new compliance tests.

## Development setup

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/Co-Messi/actwhy
cd actwhy
npm install
```

Common tasks:

```bash
npm test          # run the vitest suite (unit + fixture-based compliance)
npm run typecheck # tsc --noEmit
npm run build     # build the CLI into dist/
npm run check     # typecheck + test + build (run this before opening a PR)
```

To run your local build as the `actwhy` command:

```bash
npm run build
node dist/actwhy.js            # or: npm link, then `actwhy`
```

## Project map

```text
src/core/     Pure, browser-safe TypeScript (no node imports) — the evaluation engine.
  patterns.ts   GitHub filter-pattern engine (*, **, ?, +, [], ! ordering).
  filters.ts    Event-level trigger evaluation (branches / tags / paths / types).
  expr.ts       Three-valued expression evaluator over @actions/expressions.
  evaluate.ts   Workflow → verdict tree (jobs, needs DAG, matrix).
  context.ts    Builds the github.* context; models unknowns.
  matrix.ts     Static matrix expansion and counting.
src/cli/      Node CLI: argument parsing, git inference, terminal renderer.
web/          Static playground built from the same core.
test/         vitest: unit tests + the filter-pattern compliance corpus.
```

`src/core/` must stay free of node-only imports so the same code runs in the browser playground.

## The fidelity-first philosophy

Every verdict actwhy emits must be **defensible against real GitHub behavior**. Concretely:

- A pull request that **changes trigger or expression semantics** must include a test, and the PR description must cite the source: a link to GitHub's documentation, or a reproduced real GitHub run that demonstrates the behavior.
- When actwhy cannot know something offline, the correct behavior is `UNKNOWN` naming the missing value — never a guessed pass or fail. Changes that trade honesty for a cleaner-looking output will not be merged.
- If a change makes actwhy match GitHub in one case but diverge in another, that is a regression. Add a test for the case you fixed *and* the case you might have broken.

## Adding a filter-semantics test

Filter-pattern behavior is the highest-fidelity part of the codebase, so it has the strongest test discipline. To add a case:

1. Find the compliance corpus under `test/` (the fixture-based filter-pattern tests).
2. Add a case with the pattern, the input (branch, tag, or path), and the expected match result.
3. In the PR, cite where the expected result comes from — GitHub's [filter-pattern documentation](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet) or a real run you reproduced.

Remember the quantifier semantics that trip up naive matchers: `?` matches **zero or one of the preceding character** and `+` matches **one or more of the preceding character** — they are not general wildcards. New cases around `?`, `+`, and `!` negation ordering are always welcome.

## Commit messages

Please use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(patterns): support character-class negation in filter patterns
fix(expr): treat empty secrets.* comparison as decisive under &&
docs(readme): clarify --event resolves runtime-only values
test(filters): add paths corpus for ? quantifier edge cases
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`.

## Pull request checklist

Before you open a PR:

- [ ] `npm run check` passes (typecheck + tests + build).
- [ ] Changes to trigger or expression semantics include a test **and** a cited source (docs link or reproduced run).
- [ ] Docs updated if behavior, flags, or limitations changed (`README.md`, `docs/limitations.md`).
- [ ] Commits follow Conventional Commits.

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
