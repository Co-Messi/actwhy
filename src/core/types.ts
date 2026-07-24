/**
 * Core data model. Everything here is browser-safe (no node imports).
 */

/** What we are simulating. */
export type EventSpec = PushSpec | PrSpec;

export interface PushSpec {
  kind: "push";
  /** Branch name (e.g. "main") — mutually exclusive with `tag`. */
  branch?: string;
  /** Tag name (e.g. "v1.2.0"). */
  tag?: string;
  /**
   * Changed files in the push. `null` means "unknown" — paths filters will
   * yield UNKNOWN verdicts instead of guessing.
   */
  files: string[] | null;
  commitMessage?: string;
  /** "owner/repo", used for the github.repository context when known. */
  repository?: string;
  defaultBranch?: string;
  /** Extra event payload (merged over what actwhy can infer). */
  payload?: Record<string, unknown>;
  sha?: string;
  actor?: string;
}

export interface PrSpec {
  kind: "pull_request";
  /** pull_request (default) or pull_request_target. */
  event?: "pull_request" | "pull_request_target";
  /** Base (target) branch — what `branches:` filters match against. */
  base: string;
  /** Head (source) branch. */
  head?: string;
  files: string[] | null;
  /** HEAD commit message, used for GitHub's pull-request skip directives. */
  commitMessage?: string;
  /** Activity type being simulated. Default: "opened". */
  activityType?: string;
  draft?: boolean;
  repository?: string;
  defaultBranch?: string;
  payload?: Record<string, unknown>;
  actor?: string;
}

export type VerdictKind = "fires" | "skipped" | "unknown" | "error";

/** A structured, renderable explanation. */
export interface Reason {
  /** Stable machine-readable code, e.g. "branch-filter-no-match". */
  code: string;
  /** One-line human explanation. */
  message: string;
  /** Optional extra detail (e.g. the exact values compared). */
  detail?: string;
}

export interface StepVerdict {
  index: number;
  name: string;
  verdict: VerdictKind;
  reasons: Reason[];
}

export interface JobVerdict {
  id: string;
  name?: string;
  verdict: VerdictKind;
  reasons: Reason[];
  needs: string[];
  /** Number of matrix variants, or "unknown" when the matrix is dynamic. */
  matrix?: number | "unknown";
  matrixNote?: string;
  steps?: StepVerdict[];
}

export interface WorkflowVerdict {
  /** File name relative to .github/workflows, e.g. "ci.yml". */
  file: string;
  name?: string;
  verdict: VerdictKind;
  reasons: Reason[];
  jobs: JobVerdict[];
  /** Non-fatal observations, e.g. always-true `if:` footguns. */
  warnings: Reason[];
}

export interface ReportSummary {
  workflowsTotal: number;
  workflowsFiring: number;
  workflowsSkipped: number;
  workflowsUnknown: number;
  workflowsError: number;
  jobsFiring: number;
  matrixVariantsFiring: number | "unknown";
}

export interface Report {
  event: EventSpec;
  workflows: WorkflowVerdict[];
  summary: ReportSummary;
  /** True when not a single workflow fires for this event. */
  nothingFires: boolean;
  /** The most instructive near-miss when nothing fires. */
  closestMiss?: { file: string; reason: Reason };
}

export interface WorkflowFile {
  /** Base name, e.g. "ci.yml". */
  name: string;
  content: string;
}

/** Options for the evaluator. */
export interface EvaluateOptions {
  /** Also evaluate step-level `if:` conditions. */
  steps?: boolean;
}
