# Review Remediation Design

## Objective

Make actwhy's published promise—predict GitHub Actions trigger decisions without
guessing—true across every issue reproduced in the full review, then tighten the
playground so a first-time visitor reaches a personal result quickly on desktop
and mobile.

## Scope

### Fidelity and CLI correctness

- Match slash-delimited `**` patterns such as `docs/**/*.md` exactly.
- Ignore `paths` and `paths-ignore` for tag pushes.
- Honor GitHub commit-message skip directives for `push` and `pull_request`,
  while leaving `pull_request_target` unaffected.
- Skip path-filtered workflows when the changed-file set is known empty.
- Treat matrices over GitHub's 256-job limit as job errors rather than firing
  variants.
- Stop silently substituting the last commit when an upstream branch has no
  outgoing commits; report a truthful no-pending-push state.
- Support filtered-array expressions such as
  `github.event.pull_request.labels.*.name`.
- Correct limitations and release guidance that currently overstate fidelity.

### Playground experience

- Make the playground—not installation or starring—the primary hero action.
- Give first-time visitors a short path from the sample to their own workflow.
- Add contextual next actions for skipped or unknown verdicts.
- Keep a compact verdict visible after mobile edits.
- Make share-link privacy language explicit about URL exposure.
- Reserve animation for meaningful verdict changes and respect reduced-motion
  preferences.

## Approaches considered

1. **Patch only the four reproduced divergences.** Fastest, but it leaves
   adjacent correctness and UX claims from the same review unresolved.
2. **Rewrite the evaluator around another glob/expression package.** Broader
   replacement, but it sacrifices the existing small, audited core and creates
   unnecessary migration risk.
3. **Recommended: targeted fidelity hardening plus bounded UX polish.** Preserve
   the current architecture, add failing regression tests for every behavior,
   repair the smallest responsible components, and expand the playground
   without adding accounts, telemetry, persistence, or backend state.

## Architecture

The browser-safe `src/core` and Node-only `src/cli` boundary remains unchanged.
Pattern matching gains an explicit slash-aware globstar token. Trigger
evaluation gains event-level preconditions before branch/path filters.
Expression evaluation implements the parser's filtered-array visitor instead
of treating it as an evaluation error.

The web remains static and client-side. New onboarding and resolution actions
operate only on the existing `AppState`; they do not persist workflow content
or make network requests.

## Error handling

- Unsupported or invalid constructs resolve to a structured `UNKNOWN` or
  `ERROR`, never a confident `FIRES`.
- Known GitHub-wide suppression such as `[skip ci]` produces a structured skip
  reason.
- No-pending-push inference is explicit in the CLI header and does not
  fabricate the last commit as an outgoing push.
- Share copy states that YAML and event data are embedded in the URL.

## Verification

- Red/green tests for every fidelity and CLI behavior.
- Full typecheck, unit/e2e suite, CLI build, web build, and package dry run.
- Browser checks at desktop and mobile widths, keyboard operation, reduced
  motion, console/network errors, and the main edit-to-verdict flow.
- Current npm advisory audit.
- Clean branch diff, pushed branch, and an open PR with no merge action.
