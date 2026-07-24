/**
 * Expression-context construction.
 *
 * The context is a plain JS tree. A leaf (or whole subtree) whose value only
 * exists at runtime is an `Unk` sentinel carrying the human explanation of
 * why it cannot be known statically — this is what powers honest UNKNOWN
 * verdicts instead of guesses.
 */

import type { EventSpec, PrSpec, PushSpec } from "./types.js";

/** Marks a value that only exists at runtime. */
export class Unk {
  constructor(
    /** Why this can't be known statically, e.g. "secrets are runtime-only". */
    public readonly why: string,
    /** How the user can supply it, e.g. "--event payload.json". */
    public readonly hint?: string,
  ) {}
}

/**
 * A dictionary whose listed keys are known but which may have additional
 * keys we cannot enumerate (e.g. a webhook payload). Missing keys resolve
 * to Unk instead of null.
 */
export class PartialDict {
  constructor(
    public readonly entries: Record<string, CtxValue>,
    public readonly why: string,
    public readonly hint?: string,
  ) {}
}

export type CtxValue =
  | string
  | number
  | boolean
  | null
  | Unk
  | PartialDict
  | CtxValue[]
  | { [key: string]: CtxValue };

export interface RootContext {
  [name: string]: CtxValue;
}

const EVENT_HINT = "supply it with --event payload.json";

function pushPayload(spec: PushSpec): PartialDict {
  const ref = spec.tag ? `refs/tags/${spec.tag}` : `refs/heads/${spec.branch}`;
  const entries: Record<string, CtxValue> = {
    ref,
    created: false,
    deleted: false,
    forced: new Unk("whether the push is a force-push is runtime-only", EVENT_HINT),
    head_commit: new PartialDict(
      spec.commitMessage !== undefined ? { message: spec.commitMessage } : {},
      "full head_commit details are runtime-only",
      EVENT_HINT,
    ),
    commits: new Unk("the commit list is runtime-only", EVENT_HINT),
    before: new Unk("the previous ref SHA is runtime-only", EVENT_HINT),
    after: spec.sha ?? new Unk("the pushed SHA is not known before pushing", EVENT_HINT),
    repository: new PartialDict(
      repoEntries(spec.repository, spec.defaultBranch),
      "full repository details are runtime-only",
      EVENT_HINT,
    ),
    pusher: new Unk("pusher details are runtime-only", EVENT_HINT),
    sender: new Unk("sender details are runtime-only", EVENT_HINT),
  };
  return new PartialDict(entries, "push payload fields are runtime-only", EVENT_HINT);
}

function repoEntries(repository?: string, defaultBranch?: string): Record<string, CtxValue> {
  const entries: Record<string, CtxValue> = {};
  if (repository) {
    entries.full_name = repository;
    entries.name = repository.split("/")[1] ?? repository;
    entries.owner = new PartialDict(
      { login: repository.split("/")[0] },
      "full owner details are runtime-only",
      EVENT_HINT,
    );
  }
  if (defaultBranch) entries.default_branch = defaultBranch;
  return entries;
}

function prPayload(spec: PrSpec): PartialDict {
  const pr: Record<string, CtxValue> = {
    base: new PartialDict(
      { ref: spec.base, ...(spec.repository ? { repo: new PartialDict(repoEntries(spec.repository, spec.defaultBranch), "runtime-only", EVENT_HINT) } : {}) },
      "full base details are runtime-only",
      EVENT_HINT,
    ),
    head: new PartialDict(
      spec.head ? { ref: spec.head } : {},
      "full head details are runtime-only",
      EVENT_HINT,
    ),
    draft: spec.draft ?? false,
    merged: false,
    state: "open",
    number: new Unk("the PR number is runtime-only", EVENT_HINT),
    title: new Unk("the PR title is runtime-only", EVENT_HINT),
    body: new Unk("the PR body is runtime-only", EVENT_HINT),
    labels: new Unk("PR labels are runtime-only", EVENT_HINT),
    user: new Unk("the PR author is runtime-only", EVENT_HINT),
  };
  const entries: Record<string, CtxValue> = {
    action: spec.activityType ?? "opened",
    number: new Unk("the PR number is runtime-only", EVENT_HINT),
    pull_request: new PartialDict(pr, "full pull_request details are runtime-only", EVENT_HINT),
    repository: new PartialDict(
      repoEntries(spec.repository, spec.defaultBranch),
      "full repository details are runtime-only",
      EVENT_HINT,
    ),
    sender: new Unk("sender details are runtime-only", EVENT_HINT),
  };
  return new PartialDict(entries, "pull_request payload fields are runtime-only", EVENT_HINT);
}

/** Keys that must never be copied from user JSON into a context object. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep-merge a user-supplied JSON payload over the inferred payload. */
function mergePayload(base: PartialDict, user: Record<string, unknown>): PartialDict {
  const entries = { ...base.entries };
  for (const [k, v] of Object.entries(user)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const existing = entries[k];
    if (
      existing instanceof PartialDict &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      entries[k] = mergePayload(existing, v as Record<string, unknown>);
    } else {
      entries[k] = v as CtxValue;
    }
  }
  return new PartialDict(entries, base.why, base.hint);
}

/**
 * Build the `github` context (and friends) for the simulated event.
 * Documented github.* keys we cannot know become Unk; keys outside the
 * documented set resolve to null, matching GitHub's behavior.
 */
export function buildRootContext(spec: EventSpec): RootContext {
  const runtime = (what: string) => new Unk(`${what} is runtime-only`);

  let eventName: string;
  let ref: string;
  let refName: string;
  let refType: string;
  let baseRef: CtxValue = "";
  let headRef: CtxValue = "";
  let payload: PartialDict;
  let sha: CtxValue;

  if (spec.kind === "push") {
    eventName = "push";
    refName = spec.tag ?? spec.branch ?? "";
    ref = spec.tag ? `refs/tags/${spec.tag}` : `refs/heads/${spec.branch}`;
    refType = spec.tag ? "tag" : "branch";
    payload = pushPayload(spec);
    sha = spec.sha ?? new Unk("the pushed SHA is not known before pushing");
  } else {
    eventName = spec.event ?? "pull_request";
    payload = prPayload(spec);
    baseRef = spec.base;
    headRef = spec.head ?? new Unk("head branch not specified", "pass --head <branch>");
    if (eventName === "pull_request_target") {
      ref = `refs/heads/${spec.base}`;
      refName = spec.base;
    } else {
      ref = new Unk("the merge ref number is runtime-only (refs/pull/<n>/merge)") as unknown as string;
      refName = new Unk("the merge ref number is runtime-only (<n>/merge)") as unknown as string;
    }
    refType = "branch";
    sha = new Unk("the merge commit SHA is runtime-only");
  }

  if (spec.payload) payload = mergePayload(payload, spec.payload);

  const repository = spec.repository ?? runtime("the repository slug");
  const owner =
    spec.repository?.split("/")[0] ?? (runtime("the repository owner") as CtxValue);

  const github: Record<string, CtxValue> = {
    event_name: eventName,
    ref: ref as CtxValue,
    ref_name: refName as CtxValue,
    ref_type: refType,
    ref_protected: runtime("branch protection state"),
    base_ref: baseRef,
    head_ref: headRef,
    sha,
    event: payload,
    repository,
    repository_owner: owner,
    repository_id: runtime("the repository id"),
    repository_owner_id: runtime("the owner id"),
    repositoryUrl: runtime("the repository git URL"),
    actor: spec.actor ?? runtime("the triggering actor"),
    actor_id: runtime("the actor id"),
    triggering_actor: spec.actor ?? runtime("the triggering actor"),
    event_path: runtime("the event payload path"),
    workflow: runtime("the workflow name context"),
    workflow_ref: runtime("the workflow ref"),
    workflow_sha: runtime("the workflow SHA"),
    job: runtime("the job id context"),
    run_id: runtime("the run id"),
    run_number: runtime("the run number"),
    run_attempt: runtime("the run attempt"),
    retention_days: runtime("retention settings"),
    secret_source: runtime("the secret source"),
    server_url: "https://github.com",
    api_url: "https://api.github.com",
    graphql_url: "https://api.github.com/graphql",
    workspace: runtime("the runner workspace path"),
    action: runtime("the action id context"),
    token: new Unk("the GITHUB_TOKEN is a secret"),
  };

  return {
    github,
    vars: new Unk("repository/organization variables are not readable locally"),
    secrets: new Unk("secrets are never readable locally (by design)"),
    inputs: new Unk("inputs only exist for workflow_dispatch / workflow_call"),
    runner: new Unk("runner details only exist at runtime"),
    strategy: new Unk("strategy context only exists at runtime"),
    matrix: new Unk("matrix values vary per variant at runtime"),
    steps: new Unk("step outputs only exist at runtime"),
    job: new Unk("the job context only exists at runtime"),
    // `needs` and `env` are injected per-job by the evaluator.
  };
}
