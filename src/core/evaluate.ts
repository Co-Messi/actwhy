/**
 * The actwhy engine: turn workflow files + a simulated event into a
 * verdict tree with honest, structured explanations.
 */

import {
  NoOperationTraceWriter,
  convertWorkflowTemplate,
  parseWorkflow,
} from "@actions/workflow-parser";
import type { WorkflowTemplate } from "@actions/workflow-parser";
import { buildRootContext, Unk, type CtxValue, type RootContext } from "./context.js";
import { evaluateIf, type EvalOutcome, type StatusAssumptions, type Truthiness } from "./expr.js";
import { evaluateTrigger } from "./filters.js";
import { expandMatrix } from "./matrix.js";
import type {
  EvaluateOptions,
  EventSpec,
  JobVerdict,
  Reason,
  Report,
  StepVerdict,
  VerdictKind,
  WorkflowFile,
  WorkflowVerdict,
} from "./types.js";

export async function evaluateWorkflows(
  files: WorkflowFile[],
  spec: EventSpec,
  options: EvaluateOptions = {},
): Promise<Report> {
  const workflows: WorkflowVerdict[] = [];
  for (const file of files) {
    workflows.push(await evaluateOne(file, spec, options));
  }
  workflows.sort(byVerdictThenName);

  const firing = workflows.filter((w) => w.verdict === "fires");
  const jobsFiring = firing.flatMap((w) => w.jobs.filter((j) => j.verdict === "fires"));
  let matrixVariants: number | "unknown" = 0;
  for (const j of jobsFiring) {
    if (j.matrix === "unknown") {
      matrixVariants = "unknown";
      break;
    }
    matrixVariants += j.matrix ?? 1;
  }

  const nothingFires = firing.length === 0 && workflows.length > 0;
  return {
    event: spec,
    workflows,
    summary: {
      workflowsTotal: workflows.length,
      workflowsFiring: firing.length,
      workflowsSkipped: workflows.filter((w) => w.verdict === "skipped").length,
      workflowsUnknown: workflows.filter((w) => w.verdict === "unknown").length,
      workflowsError: workflows.filter((w) => w.verdict === "error").length,
      jobsFiring: jobsFiring.length,
      matrixVariantsFiring: matrixVariants,
    },
    nothingFires,
    closestMiss: nothingFires ? closestMiss(workflows) : undefined,
  };
}

const VERDICT_ORDER: Record<VerdictKind, number> = {
  fires: 0,
  unknown: 1,
  skipped: 2,
  error: 3,
};

function byVerdictThenName(a: WorkflowVerdict, b: WorkflowVerdict): number {
  return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.file.localeCompare(b.file);
}

/**
 * Rank skipped workflows by how close they came to firing — the most
 * instructive near-miss for the "nothing fires" headline.
 */
const MISS_RANK: Record<string, number> = {
  "paths-filter-no-match": 0,
  "paths-all-ignored": 0,
  "branch-filter-no-match": 1,
  "base-branch-filter-no-match": 1,
  "branch-ignored": 1,
  "base-branch-ignored": 1,
  "tag-filter-no-match": 1,
  "tag-ignored": 1,
  "activity-type-no-match": 2,
  "tag-push-branch-filters-only": 3,
  "branch-push-tag-filters-only": 3,
  "event-not-listened": 4,
};

function closestMiss(workflows: WorkflowVerdict[]): Report["closestMiss"] {
  let best: { file: string; reason: Reason; rank: number } | undefined;
  for (const w of workflows) {
    if (w.verdict !== "skipped" || w.reasons.length === 0) continue;
    const reason = w.reasons[0];
    const rank = MISS_RANK[reason.code] ?? 5;
    if (!best || rank < best.rank) best = { file: w.file, reason, rank };
  }
  return best ? { file: best.file, reason: best.reason } : undefined;
}

async function evaluateOne(
  file: WorkflowFile,
  spec: EventSpec,
  options: EvaluateOptions,
): Promise<WorkflowVerdict> {
  let template: WorkflowTemplate;
  try {
    const parsed = parseWorkflow(
      { name: file.name, content: file.content },
      new NoOperationTraceWriter(),
    );
    const errors = parsed.context.errors.getErrors();
    if (errors.length > 0 || parsed.value === undefined) {
      return {
        file: file.name,
        verdict: "error",
        reasons: errors.slice(0, 5).map((e) => ({
          code: "parse-error",
          message: e.message,
        })),
        jobs: [],
        warnings: [],
      };
    }
    template = await convertWorkflowTemplate(parsed.context, parsed.value);
    if (template.errors && template.errors.length > 0) {
      return {
        file: file.name,
        verdict: "error",
        reasons: template.errors.slice(0, 5).map((e) => ({
          code: "parse-error",
          message: e.Message,
        })),
        jobs: [],
        warnings: [],
      };
    }
  } catch (e) {
    return {
      file: file.name,
      verdict: "error",
      reasons: [
        {
          code: "parse-error",
          message: e instanceof Error ? e.message : String(e),
        },
      ],
      jobs: [],
      warnings: [],
    };
  }

  const name = workflowName(template);
  const trigger = evaluateTrigger(template.events, spec);
  if (trigger.verdict !== "fires") {
    return {
      file: file.name,
      name,
      verdict: trigger.verdict,
      reasons: trigger.reasons,
      jobs: [],
      warnings: trigger.warnings,
    };
  }

  const warnings: Reason[] = [...trigger.warnings];
  const context = buildRootContext(spec);
  const jobs = evaluateJobs(template, context, options, warnings);

  return { file: file.name, name, verdict: "fires", reasons: [], jobs, warnings };
}

function workflowName(template: WorkflowTemplate): string | undefined {
  // WorkflowTemplate has no first-class name field in this version; the
  // file name is the stable identifier we present.
  return undefined;
}

interface JobLike {
  id: { value: string };
  name?: { toString(): string };
  needs?: { value: string }[];
  if: { expression: string };
  strategy?: Parameters<typeof expandMatrix>[0];
  type: string;
  steps?: StepLike[];
  env?: unknown;
}

interface StepLike {
  id: string;
  name?: { toString(): string };
  if?: { expression: string };
}

function evaluateJobs(
  template: WorkflowTemplate,
  context: RootContext,
  options: EvaluateOptions,
  warnings: Reason[],
): JobVerdict[] {
  const jobs = template.jobs as unknown as JobLike[];
  const byId = new Map(jobs.map((j) => [j.id.value, j]));
  const verdicts = new Map<string, JobVerdict>();

  // Topological evaluation over the needs DAG (cycles are parser errors,
  // but guard anyway).
  const visiting = new Set<string>();
  const visit = (id: string): JobVerdict => {
    const existing = verdicts.get(id);
    if (existing) return existing;
    const job = byId.get(id);
    if (!job) {
      const missing: JobVerdict = {
        id,
        verdict: "error",
        reasons: [{ code: "missing-need", message: `job "${id}" not found` }],
        needs: [],
      };
      verdicts.set(id, missing);
      return missing;
    }
    if (visiting.has(id)) {
      const cyclic: JobVerdict = {
        id,
        verdict: "error",
        reasons: [{ code: "needs-cycle", message: `circular needs involving "${id}"` }],
        needs: (job.needs ?? []).map((n) => n.value),
      };
      verdicts.set(id, cyclic);
      return cyclic;
    }
    visiting.add(id);
    const v = evaluateJob(job, (job.needs ?? []).map((n) => visit(n.value)), context, options, warnings);
    visiting.delete(id);
    verdicts.set(id, v);
    return v;
  };

  for (const j of jobs) visit(j.id.value);
  // Preserve the file's job order.
  return jobs.map((j) => verdicts.get(j.id.value)!);
}

function evaluateJob(
  job: JobLike,
  needResults: JobVerdict[],
  context: RootContext,
  options: EvaluateOptions,
  warnings: Reason[],
): JobVerdict {
  const needs = needResults.map((n) => n.id);
  const base: Omit<JobVerdict, "verdict" | "reasons"> = {
    id: job.id.value,
    name: job.name?.toString(),
    needs,
  };

  const matrix = expandMatrix(job.strategy);
  if (matrix) {
    base.matrix = matrix.count;
    base.matrixNote = matrix.note;
  }

  if (job.type === "reusableWorkflowJob") {
    base.matrixNote = base.matrixNote ?? "reusable workflow call";
  }

  // Status assumptions for this job's `if:`.
  const anyNeedSkipped = needResults.some((n) => n.verdict === "skipped");
  const anyNeedUnknown = needResults.some((n) => n.verdict === "unknown" || n.verdict === "error");
  const success: Truthiness = anyNeedSkipped ? false : anyNeedUnknown ? "unknown" : true;
  const statuses: StatusAssumptions = {
    success,
    // Happy-path assumption: no job fails or is cancelled. Surfaced in the
    // verdict text whenever failure()/cancelled() influenced the outcome.
    failure: false,
    cancelled: false,
  };

  // Inject per-job contexts: needs.<id>.result / outputs.
  const needsCtx: Record<string, CtxValue> = {};
  for (const n of needResults) {
    needsCtx[n.id] = {
      result:
        n.verdict === "fires"
          ? "success"
          : n.verdict === "skipped"
            ? "skipped"
            : (new Unk("depends on runtime results") as unknown as CtxValue as never),
      outputs: new Unk(
        `outputs of job "${n.id}" only exist at runtime`,
        "run with --event to inject values is not supported for needs — this stays unknown by design",
      ) as unknown as CtxValue,
    } as CtxValue;
  }
  const jobContext: RootContext = {
    ...context,
    needs: needsCtx,
    env: new Unk(
      "the env context is not available in job-level `if` (GitHub restriction)",
    ) as unknown as CtxValue,
  };

  const outcome = evaluateIf(job.if.expression, jobContext, statuses);
  if (outcome.footgun) {
    warnings.push({
      code: "always-true-if",
      message: `job "${job.id.value}": ${outcome.footgun}`,
    });
  }

  const verdictInfo = verdictFromOutcome(outcome, job.if.expression, needResults, anyNeedSkipped);
  const result: JobVerdict = { ...base, ...verdictInfo };

  if (options.steps && job.steps && verdictInfo.verdict === "fires") {
    result.steps = job.steps.map((s, i) => evaluateStep(s, i, jobContext));
  }
  return result;
}

function verdictFromOutcome(
  outcome: EvalOutcome,
  expression: string,
  needResults: JobVerdict[],
  anyNeedSkipped: boolean,
): { verdict: VerdictKind; reasons: Reason[] } {
  if (outcome.error) {
    return {
      verdict: "unknown",
      reasons: [{ code: "expression-error", message: outcome.error, detail: `if: ${expression}` }],
    };
  }

  const isDefaultIf = expression.trim() === "success()";
  const usedFailure = outcome.statusFnsUsed.has("failure");

  if (outcome.truthiness === true) {
    return { verdict: "fires", reasons: [] };
  }

  if (outcome.truthiness === false) {
    if (isDefaultIf && anyNeedSkipped) {
      const skipped = needResults.filter((n) => n.verdict === "skipped").map((n) => n.id);
      return {
        verdict: "skipped",
        reasons: [
          {
            code: "needs-skipped",
            message: `needed job${skipped.length > 1 ? "s" : ""} ${skipped.map((s) => `"${s}"`).join(", ")} ${skipped.length > 1 ? "were" : "was"} skipped`,
          },
        ],
      };
    }
    if (usedFailure) {
      return {
        verdict: "skipped",
        reasons: [
          {
            code: "failure-gated",
            message: "only runs when a needed job fails (actwhy assumes runs succeed)",
            detail: `if: ${stripDefaultWrapper(expression)}`,
          },
        ],
      };
    }
    return {
      verdict: "skipped",
      reasons: [
        {
          code: "if-false",
          message: `if condition is false`,
          detail: explainCondition(expression, outcome),
        },
      ],
    };
  }

  // unknown
  const deps = outcome.deps.slice(0, 3);
  return {
    verdict: "unknown",
    reasons: [
      {
        code: "if-unknown",
        message: `depends on ${deps.map((d) => d.path).join(", ")}${outcome.deps.length > 3 ? ", …" : ""}`,
        detail: deps
          .map((d) => `${d.path}: ${d.why}${d.hint ? ` (${d.hint})` : ""}`)
          .join("; "),
      },
    ],
  };
}

/** Remove the parser's implicit `success() && (…)` wrapper for display. */
function stripDefaultWrapper(expression: string): string {
  const m = expression.match(/^success\(\) && \((.*)\)$/s);
  return m ? m[1] : expression;
}

function explainCondition(expression: string, outcome: EvalOutcome): string {
  const display = stripDefaultWrapper(expression);
  const reads = [...outcome.reads.entries()]
    .slice(0, 4)
    .map(([path, value]) => `${path} is "${value}"`)
    .join(", ");
  return reads.length > 0 ? `${display} — ${reads}` : display;
}

function evaluateStep(step: StepLike, index: number, jobContext: RootContext): StepVerdict {
  const name = step.name?.toString() ?? step.id ?? `step ${index + 1}`;
  const expression = step.if?.expression ?? "success()";
  // Step-level: env IS available; matrix/steps contexts stay unknown.
  const stepContext: RootContext = { ...jobContext };
  delete (stepContext as Record<string, unknown>).env;
  stepContext.env = new Unk("static env evaluation at step level is not yet implemented");
  const outcome = evaluateIf(expression, stepContext, {
    success: true,
    failure: false,
    cancelled: false,
  });

  if (outcome.error) {
    return {
      index,
      name,
      verdict: "unknown",
      reasons: [{ code: "expression-error", message: outcome.error }],
    };
  }
  if (outcome.truthiness === true) return { index, name, verdict: "fires", reasons: [] };
  if (outcome.truthiness === false) {
    const usedFailure = outcome.statusFnsUsed.has("failure");
    return {
      index,
      name,
      verdict: "skipped",
      reasons: [
        usedFailure
          ? {
              code: "failure-gated",
              message: "only runs when a previous step fails (actwhy assumes steps succeed)",
            }
          : {
              code: "if-false",
              message: "if condition is false",
              detail: explainCondition(expression, outcome),
            },
      ],
    };
  }
  const deps = outcome.deps.slice(0, 3);
  return {
    index,
    name,
    verdict: "unknown",
    reasons: [
      {
        code: "if-unknown",
        message: `depends on ${deps.map((d) => d.path).join(", ")}`,
      },
    ],
  };
}
