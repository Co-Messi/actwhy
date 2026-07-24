import type { Report } from "../../src/core/types.js";

export type ResolutionActionId =
  | "test-branch"
  | "add-path"
  | "switch-pr"
  | "copy-reason"
  | "share";

export interface ResolutionAction {
  id: ResolutionActionId;
  label: string;
  detail: string;
}

const BRANCH_REASONS = new Set([
  "branch-filter-no-match",
  "branch-ignored",
  "base-branch-filter-no-match",
  "base-branch-ignored",
]);

const PATH_REASONS = new Set([
  "paths-filter-no-match",
  "paths-all-ignored",
  "changed-files-unknown",
  "no-changed-files",
]);

function primaryReason(report: Report) {
  return (
    report.closestMiss?.reason ??
    report.workflows.find((workflow) => workflow.reasons.length > 0)?.reasons[0]
  );
}

/** Short, scenario-specific actions that help turn a verdict into a next test. */
export function resolutionActions(report: Report): ResolutionAction[] {
  const reason = primaryReason(report);
  const actions: ResolutionAction[] = [];

  if (reason && BRANCH_REASONS.has(reason.code)) {
    actions.push({
      id: "test-branch",
      label: "Test another branch",
      detail: "Focus the branch input and try the ref you intend to push.",
    });
  } else if (reason && PATH_REASONS.has(reason.code)) {
    actions.push({
      id: "add-path",
      label: "Add a changed path",
      detail: "Focus changed files and add the path you expect GitHub to diff.",
    });
  }

  if (report.event.kind === "push" && report.event.tag === undefined) {
    actions.push({
      id: "switch-pr",
      label: "Switch to pull request",
      detail: "See whether the PR trigger makes a different decision.",
    });
  }

  if (reason) {
    actions.push({
      id: "copy-reason",
      label: "Copy the reason",
      detail: reason.message,
    });
  }

  actions.push({
    id: "share",
    label: "Share this scenario",
    detail: "Copy a URL containing the current workflow and simulated event.",
  });
  return actions;
}
