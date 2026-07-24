# Review Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair every confirmed review finding and make the static playground's first-use, resolution, mobile, privacy, and motion experience launch-ready.

**Architecture:** Preserve the browser-safe core and Node-only CLI split. Add focused structured reasons and state transitions rather than broad new abstractions; keep all web behavior client-side and derive resolution actions from the existing report/state.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, GitHub `@actions/workflow-parser` and `@actions/expressions`, esbuild, static HTML/CSS/DOM.

---

### Task 1: GitHub filter fidelity

**Files:**
- Modify: `src/core/patterns.ts`
- Modify: `src/core/filters.ts`
- Test: `test/patterns.test.ts`
- Test: `test/evaluate.test.ts`

**Steps:**
1. Add failing tests proving `docs/**/*.md` matches both `docs/README.md` and deeper files.
2. Run `npx vitest run test/patterns.test.ts` and confirm the root-level case fails.
3. Implement a slash-aware globstar atom so `/**/` matches zero or more complete path segments without reintroducing backtracking.
4. Add failing evaluator tests proving tag pushes ignore path filters and known-empty changed-file sets skip both `paths` and `paths-ignore` workflows.
5. Run `npx vitest run test/evaluate.test.ts` and confirm both fail for the reviewed reasons.
6. Implement event and empty-diff preconditions in `evaluateTrigger`.
7. Run both test files and the ReDoS suite.
8. Commit as `fix: match GitHub trigger filter semantics`.

### Task 2: Commit skip directives

**Files:**
- Modify: `src/core/filters.ts`
- Modify: `src/core/types.ts`
- Test: `test/evaluate.test.ts`
- Test: `test/e2e-cli.test.ts`

**Steps:**
1. Add failing tests for all five bracket directives and both `skip-checks` trailer forms.
2. Add a negative test proving incidental prose and `pull_request_target` do not skip.
3. Run targeted tests and confirm the ordinary push/PR cases incorrectly fire.
4. Add a precise commit-message parser and structured `commit-message-skip` reason.
5. Ensure PR specs can carry the HEAD commit message through CLI and web state.
6. Run targeted tests and commit as `fix: honor GitHub workflow skip directives`.

### Task 3: Matrix and expression truthfulness

**Files:**
- Modify: `src/core/evaluate.ts`
- Modify: `src/core/expr.ts`
- Modify: `src/core/types.ts`
- Test: `test/roast-fixes.test.ts`
- Test: `test/expr.test.ts`

**Steps:**
1. Change the existing over-limit expectation to require an error job and zero firing variants; run it and confirm failure.
2. Return a structured `matrix-over-limit` job error before condition evaluation.
3. Add a failing filtered-array expression test for `labels.*.name`.
4. Implement `visitFilteredArray` using the actions expression data model while preserving unknown dependencies.
5. Run targeted tests, then commit as `fix: keep matrix and expression verdicts honest`.

### Task 4: Git inference and invalid filter combinations

**Files:**
- Modify: `src/cli/git.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/core/filters.ts`
- Test: `test/git-inference.test.ts`
- Test: `test/e2e-cli.test.ts`
- Test: `test/evaluate.test.ts`

**Steps:**
1. Add a failing git-inference test requiring a synchronized upstream to return a known empty outgoing set rather than last-commit files.
2. Implement the truthful result and a `no outgoing commits` source label.
3. Add failing tests requiring mutually exclusive include/ignore filter pairs to return an error instead of a guessed precedence rule.
4. Add structured invalid-filter-combination handling.
5. Run targeted tests and commit as `fix: stop fabricating push and invalid-filter outcomes`.

### Task 5: Documentation and release truthfulness

**Files:**
- Modify: `README.md`
- Modify: `docs/limitations.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Steps:**
1. Correct the 1,000-commits versus file-diff-limit explanation.
2. Document skip directives, globstar behavior, empty diffs, filtered arrays, matrix errors, and explicit no-pending-push behavior.
3. Remove the unsupported `paths`/`paths-ignore` precedence claim.
4. Bump the package to `0.1.1` so the PR can produce a source-identifiable release after merge.
5. Run `npm install --package-lock-only` and verify package/lock versions agree.
6. Commit as `docs: align fidelity and release contract`.

### Task 6: Playground onboarding and action hierarchy

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/main.ts`
- Test: create `test/web-ui.test.ts`

**Steps:**
1. Add DOM-level tests for a primary `Try the playground` action and a personal-workflow onboarding prompt.
2. Demote GitHub starring from the primary hero action while retaining it as a secondary trust link.
3. Make the primary action focus/scroll to the workflow editor.
4. Add concise “replace this example” and “keep exploring” guidance.
5. Run the web UI tests and commit as `feat: shorten the playground first-use path`.

### Task 7: Resolution actions, mobile feedback, privacy, and motion

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/main.ts`
- Modify: `web/src/render.ts`
- Modify: `web/src/share.ts`
- Test: `test/web-ui.test.ts`

**Steps:**
1. Add failing tests for copy-reason, switch-event, and view-updated-verdict actions.
2. Render contextual resolution controls from structured reason codes.
3. Add a mobile sticky verdict summary that links to the refreshed verdict panel.
4. Update share disclosure to state that the URL contains YAML and event values.
5. Animate only when verdict signatures change and disable nonessential motion under `prefers-reduced-motion`.
6. Run web tests and commit as `feat: close the diagnosis-to-resolution loop`.

### Task 8: Browser, accessibility, and packaging verification

**Files:**
- Modify only if verification exposes defects.

**Steps:**
1. Run `npm run check` and `npm run build:web`.
2. Run `npm audit --json` and confirm zero current advisories or document exceptions.
3. Run `npm pack --dry-run --json` and confirm only intended package files ship.
4. Serve `web/dist` locally and inspect desktop and 390px mobile layouts.
5. Exercise keyboard navigation, hero CTA, editing, event switching, resolution actions, share copy, and reduced motion.
6. Check browser console and runtime network requests.
7. Run `git diff --check` and verify a clean worktree.

### Task 9: Review and pull request

**Files:**
- Review every changed file.

**Steps:**
1. Use `superpowers:requesting-code-review` for an adversarial final diff review.
2. Resolve every validated finding and rerun the relevant verification.
3. Commit any final corrections.
4. Push `codex/review-remediation`.
5. Open a PR against `main` with problem, solution, fidelity reproductions, UX changes, and verification evidence.
6. Re-fetch the PR and confirm it is open, targets `main`, has the expected commits/files, and is not merged.
