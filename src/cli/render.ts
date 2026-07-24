/**
 * ANSI tree renderer. Turns a core `Report` into the human-readable output.
 *
 * Color is opt-in via `RenderOptions.color` (the CLI decides based on
 * NO_COLOR / --no-color / TTY); unicode icons are always emitted so the shape
 * survives even in no-color pipes. This module never touches the filesystem or
 * process — it returns a string.
 */

import pc from "picocolors";
import type {
  EventSpec,
  JobVerdict,
  Reason,
  Report,
  StepVerdict,
  VerdictKind,
  WorkflowVerdict,
} from "../core/index.js";

export interface RenderOptions {
  /** Enable ANSI colors. */
  color: boolean;
  /** Whether step-level detail was requested (affects the header hint only). */
  steps?: boolean;
  /** Header label describing where the changed files came from. */
  filesSource?: string;
  /** Dim advisory lines shown under the header (e.g. assumed base branch). */
  notes?: string[];
}

/** Icons are stable across color modes; color is layered on separately. */
const ICON: Record<VerdictKind, string> = {
  fires: "✔",
  skipped: "✘",
  unknown: "?",
  error: "✖",
};

export function renderReport(report: Report, opts: RenderOptions): string {
  const c = pc.createColors(opts.color);
  const lines: string[] = [];

  lines.push(header(report.event, opts, c));
  for (const note of opts.notes ?? []) lines.push(c.dim(`  ${note}`));
  lines.push("");

  for (const w of report.workflows) renderWorkflow(w, opts, c, lines);

  if (report.nothingFires) {
    lines.push("");
    renderNothingFires(report, c, lines);
  }

  lines.push("");
  lines.push(footer(report, c));

  const warnings = collectWarnings(report);
  if (warnings.length > 0) {
    lines.push("");
    lines.push(c.yellow("⚠ warnings"));
    for (const wln of warnings) lines.push(c.yellow(`  ${wln}`));
  }

  return lines.join("\n");
}

type Colors = ReturnType<typeof pc.createColors>;

function header(event: EventSpec, opts: RenderOptions, c: Colors): string {
  const sep = c.dim(" · ");
  let ev: string;
  let filesCount: number | null;

  if (event.kind === "push") {
    const ref = event.tag !== undefined ? `tag ${event.tag}` : `branch ${event.branch ?? "?"}`;
    ev = `simulating push → ${ref}`;
    filesCount = event.files === null ? null : event.files.length;
  } else {
    const name = event.event ?? "pull_request";
    const activity = event.activityType ?? "opened";
    let s = `simulating ${name} → base ${event.base}`;
    if (event.head) s += ` ← ${event.head}`;
    if (activity !== "opened") s += ` (${activity})`;
    ev = s;
    filesCount = event.files === null ? null : event.files.length;
  }

  let filesDesc: string;
  if (filesCount === null) {
    filesDesc = "changed files unknown";
  } else if (filesCount === 0) {
    filesDesc = "0 changed files";
  } else {
    const src = opts.filesSource ? ` (${opts.filesSource})` : "";
    filesDesc = `${filesCount} changed file${filesCount === 1 ? "" : "s"}${src}`;
  }

  return `${c.bold("actwhy")}${sep}${ev}${sep}${filesDesc}`;
}

function renderWorkflow(w: WorkflowVerdict, opts: RenderOptions, c: Colors, lines: string[]): void {
  if (w.verdict === "fires") {
    lines.push(`${c.green(ICON.fires)} ${c.bold(w.file)} ${c.dim("—")} ${c.green("FIRES")}`);
    const width = jobLabelWidth(w.jobs);
    for (const j of w.jobs) renderJob(j, width, opts, c, lines);
    return;
  }

  // A workflow that simply doesn't listen to this event is noise, not signal:
  // render it dim, labelled "not for this event", and prefer the friendly
  // manual-only/cron-only hint (reason.detail) over the raw "listens to" line.
  if (w.verdict === "skipped" && w.reasons[0]?.code === "event-not-listened") {
    lines.push(`${c.dim("?")} ${c.dim(w.file)} ${c.dim("— not for this event")}`);
    const r = w.reasons[0];
    lines.push(c.dim(`    ${r.detail ?? r.message}`));
    return;
  }

  if (w.verdict === "error") {
    lines.push(`${c.magenta(ICON.error)} ${c.bold(w.file)} ${c.dim("—")} ${c.magenta("invalid workflow")}`);
    for (const r of w.reasons) {
      // Parser errors can span several lines (they quote the offending YAML);
      // indent every line so the whole error sits under the workflow.
      for (const ln of r.message.split("\n")) lines.push(ln.length > 0 ? `    ${ln}` : "");
    }
    return;
  }

  const paint = w.verdict === "unknown" ? c.yellow : c.red;
  const icon = w.verdict === "unknown" ? ICON.unknown : ICON.skipped;
  const word = w.verdict === "unknown" ? "unknown" : "skipped";
  lines.push(`${paint(icon)} ${c.bold(w.file)} ${c.dim("—")} ${paint(word)}`);
  const r = w.reasons[0];
  if (r) {
    lines.push(`    ${r.message}`);
    if (r.detail) lines.push(c.dim(`      ${r.detail}`));
  }
}

function renderJob(j: JobVerdict, width: number, opts: RenderOptions, c: Colors, lines: string[]): void {
  const label = j.id.padEnd(width);

  if (j.verdict === "fires") {
    const anns = fireAnnotations(j);
    const tail = anns.length > 0 ? "   " + c.dim(anns.join("  ")) : "";
    lines.push(`  ${c.green(ICON.fires)} ${label}  ${c.green("runs")}${tail}`);
    if (opts.steps && j.steps) {
      const sw = stepLabelWidth(j.steps);
      for (const s of j.steps) renderStep(s, sw, c, lines);
    }
    return;
  }

  const paint = j.verdict === "unknown" ? c.yellow : j.verdict === "error" ? c.magenta : c.red;
  const word = j.verdict === "unknown" ? "unknown" : j.verdict === "error" ? "error" : "skipped";
  const r = j.reasons[0];
  const msg = r ? ` ${c.dim("—")} ${r.message}` : "";
  lines.push(`  ${paint(ICON[j.verdict])} ${label}  ${paint(word)}${msg}`);
  if (r?.detail) lines.push(c.dim(`      ${r.detail}`));
}

function renderStep(s: StepVerdict, width: number, c: Colors, lines: string[]): void {
  const label = s.name.padEnd(width);
  if (s.verdict === "fires") {
    lines.push(`    ${c.green(ICON.fires)} ${label}  ${c.green("runs")}`);
    return;
  }
  const paint = s.verdict === "unknown" ? c.yellow : s.verdict === "error" ? c.magenta : c.red;
  const word = s.verdict === "unknown" ? "unknown" : s.verdict === "error" ? "error" : "skipped";
  const r = s.reasons[0];
  const msg = r ? ` ${c.dim("—")} ${r.message}` : "";
  lines.push(`    ${paint(ICON[s.verdict])} ${label}  ${paint(word)}${msg}`);
  if (r?.detail) lines.push(c.dim(`        ${r.detail}`));
}

/** Parenthetical annotations for a firing job: matrix size, then needs. */
function fireAnnotations(j: JobVerdict): string[] {
  const anns: string[] = [];
  if (j.matrix === "unknown") {
    anns.push("(matrix: resolved at runtime)");
  } else if (typeof j.matrix === "number" && j.matrix > 1) {
    anns.push(`(matrix: ${j.matrix} variants)`);
  } else if (j.matrixNote) {
    // No numeric count but a note (e.g. reusable workflow call).
    anns.push(`(${j.matrixNote})`);
  }
  if (j.needs.length > 0) anns.push(`(needs: ${j.needs.join(", ")})`);
  return anns;
}

function jobLabelWidth(jobs: JobVerdict[]): number {
  let w = 4;
  for (const j of jobs) w = Math.max(w, j.id.length);
  return Math.min(w, 28);
}

function stepLabelWidth(steps: StepVerdict[]): number {
  let w = 4;
  for (const s of steps) w = Math.max(w, s.name.length);
  return Math.min(w, 28);
}

function renderNothingFires(report: Report, c: Colors, lines: string[]): void {
  const word = report.event.kind === "push" ? "push" : "pull request";
  lines.push(c.red(c.bold(`⚠ NOTHING fires for this ${word}.`)));
  if (report.closestMiss) {
    const { file, reason } = report.closestMiss;
    lines.push(`${c.dim("closest miss:")} ${c.bold(file)} ${c.dim("—")} ${reason.message}`);
  }
}

function footer(report: Report, c: Colors): string {
  const s = report.summary;
  const parts: string[] = [`${s.workflowsFiring} of ${s.workflowsTotal} workflows fire`];

  if (s.workflowsFiring > 0) {
    let jobsPart = `${s.jobsFiring} job${s.jobsFiring === 1 ? "" : "s"} run`;
    if (s.matrixVariantsFiring === "unknown") {
      jobsPart += " (matrix variants resolved at runtime)";
    } else if (s.matrixVariantsFiring !== s.jobsFiring) {
      jobsPart += ` (${s.matrixVariantsFiring} matrix variants)`;
    }
    parts.push(jobsPart);
  }

  if (s.workflowsSkipped > 0) parts.push(`${s.workflowsSkipped} skipped`);
  if (s.workflowsUnknown > 0) parts.push(`${s.workflowsUnknown} unknown`);
  if (s.workflowsError > 0) parts.push(`${s.workflowsError} invalid`);

  return parts.join(c.dim(" · "));
}

/** Flatten every workflow's warnings, prefixed with the file for context. */
function collectWarnings(report: Report): string[] {
  const out: string[] = [];
  for (const w of report.workflows) {
    for (const warn of w.warnings) out.push(`${w.file}: ${warn.message}`);
  }
  return out;
}
