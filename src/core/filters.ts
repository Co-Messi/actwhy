/**
 * Event-level trigger evaluation: does a workflow's `on:` configuration
 * match the simulated event, and if not, exactly which filter said no?
 */

import type { EventsConfig } from "@actions/workflow-parser/model/workflow-template";
import { allFilesIgnored, anyFileMatches, matchPatternList } from "./patterns.js";
import type { EventSpec, Reason, VerdictKind } from "./types.js";

export interface TriggerResult {
  verdict: VerdictKind;
  reasons: Reason[];
  warnings: Reason[];
}

const fires = (warnings: Reason[]): TriggerResult => ({ verdict: "fires", reasons: [], warnings });
const skip = (reasons: Reason[], warnings: Reason[] = []): TriggerResult => ({
  verdict: "skipped",
  reasons,
  warnings,
});
const unknown = (reasons: Reason[], warnings: Reason[] = []): TriggerResult => ({
  verdict: "unknown",
  reasons,
  warnings,
});

const DEFAULT_PR_TYPES = ["opened", "synchronize", "reopened"];

function quote(patterns: readonly string[]): string {
  return `[${patterns.map((p) => `"${p}"`).join(", ")}]`;
}

/** Human summary of what a workflow's `on:` listens to. */
export function describeTriggers(events: EventsConfig): string[] {
  return Object.keys(events).filter((k) => events[k] !== undefined);
}

export function evaluateTrigger(events: EventsConfig, spec: EventSpec): TriggerResult {
  const warnings: Reason[] = [];
  const listeners = describeTriggers(events);

  if (spec.kind === "push") {
    const push = events.push;
    if (push === undefined) {
      return skip([noListenerReason("push", listeners)]);
    }
    const isTag = spec.tag !== undefined;
    const refName = isTag ? spec.tag! : spec.branch ?? "";

    const branches = push.branches;
    const branchesIgnore = push["branches-ignore"];
    const tags = push.tags;
    const tagsIgnore = push["tags-ignore"];
    const paths = push.paths;
    const pathsIgnore = push["paths-ignore"];

    const hasBranchFilters = branches !== undefined || branchesIgnore !== undefined;
    const hasTagFilters = tags !== undefined || tagsIgnore !== undefined;

    // Per GitHub docs: with only `branches` defined, tag pushes never
    // trigger, and vice versa. With neither, both kinds trigger.
    if (isTag && hasBranchFilters && !hasTagFilters) {
      return skip([
        {
          code: "tag-push-branch-filters-only",
          message: `push trigger only has branch filters (${quote(branches ?? branchesIgnore ?? [])}), so tag pushes never fire it`,
        },
      ]);
    }
    if (!isTag && hasTagFilters && !hasBranchFilters) {
      return skip([
        {
          code: "branch-push-tag-filters-only",
          message: `push trigger only has tag filters (${quote(tags ?? tagsIgnore ?? [])}), so branch pushes never fire it`,
        },
      ]);
    }

    // Ref filters for the matching ref kind.
    const refReason = isTag
      ? checkRefFilters("tag", refName, tags, tagsIgnore)
      : checkRefFilters("branch", refName, branches, branchesIgnore);
    if (refReason) return skip([refReason]);

    const pathResult = checkPathFilters(paths, pathsIgnore, spec.files, warnings);
    if (pathResult) return pathResult;

    return fires(warnings);
  }

  // pull_request / pull_request_target
  const eventName = spec.event ?? "pull_request";
  const pr = events[eventName] as
    | (typeof events)["pull_request"]
    | undefined;
  if (pr === undefined) {
    return skip([noListenerReason(eventName, listeners)]);
  }

  const types = pr.types ?? DEFAULT_PR_TYPES;
  const activity = spec.activityType ?? "opened";
  if (!types.includes(activity)) {
    const isDefault = pr.types === undefined;
    return skip([
      {
        code: "activity-type-no-match",
        message: `activity type "${activity}" is not in the trigger's types ${quote(types)}${isDefault ? " (the default set)" : ""}`,
      },
    ]);
  }

  // `branches:` on pull_request matches the BASE (target) branch.
  const refReason = checkRefFilters("base branch", spec.base, pr.branches, pr["branches-ignore"]);
  if (refReason) return skip([refReason]);

  const pathResult = checkPathFilters(pr.paths, pr["paths-ignore"], spec.files, warnings);
  if (pathResult) return pathResult;

  return fires(warnings);
}

function noListenerReason(eventName: string, listeners: string[]): Reason {
  const others = listeners.length > 0 ? listeners.join(", ") : "nothing";
  let hint: string | undefined;
  if (listeners.length === 1 && listeners[0] === "workflow_dispatch") {
    hint = "this workflow only runs when manually dispatched";
  } else if (listeners.length === 1 && listeners[0] === "schedule") {
    hint = "this workflow only runs on its cron schedule";
  } else if (listeners.every((l) => ["workflow_dispatch", "schedule"].includes(l)) && listeners.length > 0) {
    hint = "this workflow only runs manually or on a schedule";
  }
  return {
    code: "event-not-listened",
    message: `no \`${eventName}\` trigger — this workflow listens to: ${others}`,
    detail: hint,
  };
}

function checkRefFilters(
  kind: string,
  refName: string,
  include: readonly string[] | undefined,
  ignore: readonly string[] | undefined,
): Reason | undefined {
  if (include !== undefined) {
    const m = matchPatternList(include, refName);
    if (!m.matched) {
      const negated = m.decidedBy?.negative
        ? ` (excluded by "!${m.decidedBy.source}")`
        : "";
      return {
        code: `${kind.replace(/ /g, "-")}-filter-no-match`,
        message: `${kind} filter ${quote(include)} does not match "${refName}"${negated}`,
      };
    }
  }
  if (ignore !== undefined) {
    const m = matchPatternList(ignore, refName);
    if (m.matched) {
      return {
        code: `${kind.replace(/ /g, "-")}-ignored`,
        message: `${kind} "${refName}" matches the ignore filter "${m.decidedBy?.source ?? ""}"`,
      };
    }
  }
  return undefined;
}

function checkPathFilters(
  paths: readonly string[] | undefined,
  pathsIgnore: readonly string[] | undefined,
  files: readonly string[] | null,
  warnings: Reason[],
): TriggerResult | undefined {
  if (paths === undefined && pathsIgnore === undefined) return undefined;

  if (files === null) {
    return unknown([
      {
        code: "changed-files-unknown",
        message: "this trigger has paths filters, but the changed files are unknown",
        detail: "pass --files to specify the changed files",
      },
    ]);
  }

  if (files.length === 0) {
    warnings.push({
      code: "no-changed-files",
      message:
        "no changed files detected — paths filters evaluated against an empty set",
    });
  }

  if (paths !== undefined) {
    if (matchPatternList(paths, "").startsNegative) {
      warnings.push({
        code: "paths-starts-negative",
        message: `paths filter starts with a negative pattern — GitHub expects a positive pattern first`,
      });
    }
    const m = anyFileMatches(paths, files);
    if (!m.matched) {
      return skip(
        [
          {
            code: "paths-filter-no-match",
            message: `paths filter ${quote(paths)} matches none of the ${files.length} changed file${files.length === 1 ? "" : "s"}`,
            detail: files.length > 0 && files.length <= 6 ? `changed: ${files.join(", ")}` : undefined,
          },
        ],
        warnings,
      );
    }
    return undefined;
  }

  // paths-ignore: skip only if EVERY changed file is ignored.
  const ign = allFilesIgnored(pathsIgnore!, files);
  if (files.length > 0 && ign.allIgnored) {
    return skip(
      [
        {
          code: "paths-all-ignored",
          message: `all ${files.length} changed file${files.length === 1 ? "" : "s"} match paths-ignore ${quote(pathsIgnore!)}`,
        },
      ],
      warnings,
    );
  }
  return undefined;
}
