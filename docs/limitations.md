# Limitations (v0.1)

actwhy's value comes from being *honest*: where it cannot decide something offline, it says so rather than guessing. This page lists the boundaries of the v0.1 release and, for each, exactly what actwhy reports instead of inventing an answer.

Found a case where actwhy disagrees with what GitHub actually did? That is a fidelity bug and we want it — please open a [fidelity report](../.github/ISSUE_TEMPLATE/fidelity_report.yml).

## Events

### Evaluated

actwhy fully evaluates trigger filters and `if:` conditions for:

- `push` (branch and tag)
- `pull_request`
- `pull_request_target`

### Classified but not evaluated

These events are recognized and reported, but their firing conditions are not simulated:

- `schedule`
- `merge_group`
- `workflow_run`
- `workflow_call` (reusable workflows)

**What actwhy says instead of guessing:** a workflow triggered only by these events is labeled *"not for this event"* with a short explanation (for example, *"this workflow only runs manually or on a schedule"*). It is never reported as `FIRES` or `SKIPPED` for a push or PR it does not respond to.

Scheduled and reusable-workflow evaluation are on the [roadmap](../README.md#roadmap).

## Expressions and context

### Runtime-only values

Some values simply do not exist until a workflow runs — most importantly `secrets.*` and `needs.<job>.outputs.*`. actwhy cannot and does not read secrets.

**What actwhy says instead of guessing:** any verdict that genuinely depends on such a value becomes `UNKNOWN`, naming the exact value it lacks. Thanks to three-valued (Kleene) logic, this only happens when the value actually decides the outcome — a step condition like `secrets.TOKEN != '' && false` is still a decisive `SKIPPED`, because no possible value of the secret changes the result. (Note that GitHub does not allow `secrets` in *job-level* `if:` at all — actwhy reports that as the parse error GitHub itself would raise.)

`--event payload.json` fills in **event payload** values (`github.event.*`) — a PR title, `forced`, `head_commit` details. It cannot supply `secrets.*`, `vars.*`, or `needs.*.outputs.*`; those stay honestly `UNKNOWN` by design.

### The always-true `if:` footgun

A mixed template such as `if: ${{ github.ref }} == 'refs/heads/main'` renders to a non-empty string (`refs/heads/main == 'refs/heads/main'`) and is therefore *always* truthy — the comparison never actually runs.

**What actwhy says instead of guessing:** it does not silently treat this as a passing condition. It attaches a warning identifying the always-true expression, so you can wrap the whole condition in `${{ … }}`.

## Jobs and steps

### `needs:` and job outcome

actwhy models the `needs:` DAG: a job whose dependency is skipped is itself skipped, and `always()` / `failure()` / `success()` gating is honored.

**Happy-path assumption:** verdicts assume that jobs which run also *succeed*. A job gated on `failure()` is therefore shown as *"only runs when a needed job fails"* rather than being asserted to fire or skip — actwhy reports the condition rather than predicting the run's outcome.

### Step-level environment

Step-level `env:` is not evaluated. Conditions that read a variable set by an earlier step's `env:` block cannot be resolved statically.

**What actwhy says instead of guessing:** the affected step condition resolves to `UNKNOWN` naming the environment reference, rather than assuming a value.

### Matrix expansion

Static matrices are expanded and counted. A matrix built from `fromJSON(...)` or another dynamic source is not enumerated.

**What actwhy says instead of guessing:** the job's matrix count is reported as `unknown` with a note, rather than a fabricated variant count. If a static matrix would produce **more than 256 jobs** — GitHub's hard cap, which fails the run — actwhy emits a `matrix-over-limit` warning instead of quietly reporting the job as firing.

## Concurrency

`concurrency:` groups and cancel-in-progress behavior are not modeled. actwhy answers *"would this workflow be triggered?"*, not *"would a previous run cancel it?"*.

**What actwhy says instead of guessing:** concurrency is simply not part of the verdict. A workflow that would be triggered is reported as `FIRES` regardless of whether a concurrency rule might later cancel it.

### `paths` and `paths-ignore` together

GitHub documents `paths` and `paths-ignore` as mutually exclusive on the same event; when both are present it applies `paths` and ignores `paths-ignore`.

**What actwhy says instead of guessing:** it follows GitHub (evaluates `paths`, drops `paths-ignore`) and emits a `paths-and-paths-ignore` warning so you know half the author's intent is being discarded.

## Exit codes

By default actwhy always exits `0` — a skipped or nothing-fires result is information, not a failure. Pass `--exit-code` to use it as a CI gate: it then exits `3` if any workflow is invalid and `4` if nothing fires. Usage errors (`2`) and a missing workflows directory (`1`) are always non-zero.

## Paths filters on large pushes

GitHub stops applying `paths` / `paths-ignore` filters on a push that changes **more than 1,000 files**, running the workflow regardless. actwhy does not model this edge case; it applies paths filters to whatever changed-file list it is given.

**What actwhy says instead of guessing:** for pushes near or above that threshold, treat a `paths`-based `SKIPPED` with suspicion — GitHub may run the workflow anyway. This is a known modeling gap, noted here rather than silently mis-reported.

## Fidelity

Every verdict is derived from GitHub's documented semantics and GitHub's own MIT-licensed parser and expression libraries (`@actions/workflow-parser`, `@actions/expressions`). That makes actwhy faithful by construction for the parts it evaluates — but the mapping from "documented behavior" to "what a specific push does" is exactly where subtle bugs live.

If you can reproduce a divergence between actwhy and a real GitHub run, please file a [fidelity report](../.github/ISSUE_TEMPLATE/fidelity_report.yml) with the workflow, the event, what actwhy said, what GitHub did, and a run link.
