/**
 * Thin bridge between the playground UI state and the actwhy core engine.
 * The engine itself is browser-safe (imports only @actions/* + local files).
 */
import { evaluateWorkflows } from "../../src/core/index.js";
import type { EventSpec, Report, PushSpec, PrSpec } from "../../src/core/index.js";

export type { Report, EventSpec } from "../../src/core/index.js";

export type EventKind = "push" | "pull_request" | "tag";

/** A single editor tab. */
export interface WorkflowTab {
  name: string;
  content: string;
}

/** The complete, serializable playground state. */
export interface AppState {
  files: WorkflowTab[];
  active: number;
  event: EventKind;
  branch: string;
  tag: string;
  /** Raw textarea text, one changed path per line. Blank => files unknown. */
  changed: string;
  commitMessage: string;
  prBase: string;
  prHead: string;
  prActivity: string;
}

/** Parse the changed-files textarea. Blank means "unknown" (=> null). */
export function parseChangedFiles(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const files = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return files.length > 0 ? files : null;
}

/** Turn UI state into the engine's EventSpec. */
export function buildSpec(state: AppState): EventSpec {
  const files = parseChangedFiles(state.changed);
  const commitMessage = state.commitMessage.trim() || undefined;

  if (state.event === "pull_request") {
    const pr: PrSpec = {
      kind: "pull_request",
      base: state.prBase.trim() || "main",
      files,
    };
    const head = state.prHead.trim();
    if (head) pr.head = head;
    const activity = state.prActivity.trim();
    if (activity) pr.activityType = activity;
    if (commitMessage) pr.commitMessage = commitMessage;
    return pr;
  }

  if (state.event === "tag") {
    const push: PushSpec = { kind: "push", files };
    const tag = state.tag.trim();
    if (tag) push.tag = tag;
    if (commitMessage) push.commitMessage = commitMessage;
    return push;
  }

  const push: PushSpec = { kind: "push", files };
  const branch = state.branch.trim();
  if (branch) push.branch = branch;
  if (commitMessage) push.commitMessage = commitMessage;
  return push;
}

/** Evaluate the current state against the core engine. */
export function evaluate(state: AppState): Promise<Report> {
  const files = state.files.map((f) => ({ name: f.name, content: f.content }));
  return evaluateWorkflows(files, buildSpec(state));
}
