/**
 * Render a Report into the results pane. All engine-derived text is set via
 * textContent (never innerHTML), so YAML fragments echoed inside reason
 * messages can never become live markup.
 */
import { el, clear } from "./dom.js";
import type { Report } from "./engine.js";
import type {
  JobVerdict,
  Reason,
  VerdictKind,
  WorkflowVerdict,
} from "../../src/core/types.js";

const GLYPH: Record<VerdictKind, string> = {
  fires: "✔",
  skipped: "✘",
  unknown: "?",
  error: "✖",
};

const LABEL: Record<VerdictKind, string> = {
  fires: "FIRES",
  skipped: "SKIPPED",
  unknown: "UNKNOWN",
  error: "ERROR",
};

function reasonNode(reason: Reason, kind: "reason" | "warn" = "reason"): HTMLElement {
  const wrap = el("div", { class: kind });
  if (kind === "warn") wrap.append(el("span", { class: "warn__glyph", "aria-hidden": "true" }, "⚠"));
  const body = el("div", { class: `${kind}__body` });
  body.append(el("div", { class: `${kind}__msg` }, reason.message));
  if (reason.detail) body.append(el("div", { class: `${kind}__detail` }, reason.detail));
  wrap.append(body);
  return wrap;
}

function badge(verdict: VerdictKind): HTMLElement {
  return el("span", { class: "badge", "data-verdict": verdict }, LABEL[verdict]);
}

function glyph(verdict: VerdictKind): HTMLElement {
  return el("span", { class: "glyph", "data-verdict": verdict, "aria-hidden": "true" }, GLYPH[verdict]);
}

function jobNode(job: JobVerdict): HTMLElement {
  const row = el("div", { class: "job", "data-verdict": job.verdict });
  const head = el("div", { class: "job__head" });
  head.append(glyph(job.verdict));

  const idWrap = el("div", { class: "job__id" });
  idWrap.append(el("span", { class: "job__name" }, job.id));
  if (job.name && job.name !== job.id) {
    idWrap.append(el("span", { class: "job__alias" }, job.name));
  }
  head.append(idWrap);

  const meta = el("div", { class: "job__meta" });
  if (job.needs.length > 0) {
    meta.append(el("span", { class: "chip chip--needs" }, `needs: ${job.needs.join(", ")}`));
  }
  if (job.matrix !== undefined) {
    const n = job.matrix === "unknown" ? "matrix: dynamic" : `matrix: ${job.matrix} variants`;
    meta.append(el("span", { class: "chip chip--matrix" }, n));
  }
  head.append(meta);
  head.append(badge(job.verdict));
  row.append(head);

  if (job.matrixNote) {
    row.append(el("div", { class: "job__note" }, job.matrixNote));
  }
  for (const r of job.reasons) row.append(reasonNode(r));
  return row;
}

function workflowNode(wf: WorkflowVerdict): HTMLElement {
  const card = el("article", { class: "wf", "data-verdict": wf.verdict });

  const head = el("header", { class: "wf__head" });
  head.append(glyph(wf.verdict));
  const title = el("div", { class: "wf__title" });
  title.append(el("span", { class: "wf__file" }, wf.file));
  if (wf.name) title.append(el("span", { class: "wf__name" }, wf.name));
  head.append(title);
  head.append(badge(wf.verdict));
  card.append(head);

  for (const r of wf.reasons) card.append(reasonNode(r));

  if (wf.warnings.length > 0) {
    const warnBox = el("div", { class: "wf__warnings" });
    for (const w of wf.warnings) warnBox.append(reasonNode(w, "warn"));
    card.append(warnBox);
  }

  if (wf.jobs.length > 0) {
    const jobs = el("div", { class: "jobs" });
    for (const j of wf.jobs) jobs.append(jobNode(j));
    card.append(jobs);
  }
  return card;
}

function countChip(verdict: VerdictKind, n: number): HTMLElement {
  const chip = el(
    "span",
    { class: "count", "data-verdict": verdict, "data-zero": n === 0 ? "true" : "false" },
    el("span", { class: "count__glyph", "aria-hidden": "true" }, GLYPH[verdict]),
    el("span", { class: "count__n" }, String(n)),
    el("span", { class: "count__label" }, LABEL[verdict].toLowerCase()),
  );
  return chip;
}

function bannerNode(report: Report): HTMLElement | null {
  if (!report.nothingFires) return null;
  const hasUnknown = report.summary.workflowsUnknown > 0;
  const kind = hasUnknown ? "maybe" : "nothing";
  const banner = el("div", { class: `banner banner--${kind}`, role: "status" });

  const head = el("div", { class: "banner__head" });
  head.append(el("span", { class: "banner__glyph", "aria-hidden": "true" }, hasUnknown ? "?" : "⚠"));
  head.append(
    el(
      "span",
      { class: "banner__title" },
      hasUnknown ? "Nothing is guaranteed to fire" : "NOTHING fires for this push",
    ),
  );
  banner.append(head);

  if (hasUnknown) {
    banner.append(
      el(
        "p",
        { class: "banner__sub" },
        `${report.summary.workflowsUnknown} workflow(s) are UNKNOWN — actwhy won't guess. Fill in the changed files to resolve them.`,
      ),
    );
  }

  if (report.closestMiss) {
    const miss = el("div", { class: "banner__miss" });
    miss.append(el("span", { class: "banner__miss-label" }, "Closest miss"));
    miss.append(el("span", { class: "banner__miss-file" }, report.closestMiss.file));
    miss.append(el("span", { class: "banner__miss-msg" }, report.closestMiss.reason.message));
    if (report.closestMiss.reason.detail) {
      miss.append(el("span", { class: "banner__miss-detail" }, report.closestMiss.reason.detail));
    }
    banner.append(miss);
  }
  return banner;
}

/** Render the whole report into `mount`. */
export function renderReport(report: Report, mount: HTMLElement): void {
  clear(mount);

  if (report.workflows.length === 0) {
    mount.append(
      el(
        "div",
        { class: "empty" },
        el("div", { class: "empty__glyph", "aria-hidden": "true" }, "›_"),
        el("p", { class: "empty__msg" }, "Add a workflow file on the left to see what fires."),
      ),
    );
    return;
  }

  const s = report.summary;

  // Summary bar
  const bar = el("div", { class: "summary" });
  const counts = el("div", { class: "summary__counts" });
  counts.append(countChip("fires", s.workflowsFiring));
  counts.append(countChip("skipped", s.workflowsSkipped));
  counts.append(countChip("unknown", s.workflowsUnknown));
  if (s.workflowsError > 0) counts.append(countChip("error", s.workflowsError));
  bar.append(counts);

  const totals = el("div", { class: "summary__totals" });
  totals.append(
    el("span", { class: "summary__stat" }, `${s.jobsFiring} job${s.jobsFiring === 1 ? "" : "s"}`),
  );
  const mv = s.matrixVariantsFiring === "unknown" ? "?" : String(s.matrixVariantsFiring);
  totals.append(el("span", { class: "summary__dot", "aria-hidden": "true" }, "·"));
  totals.append(
    el("span", { class: "summary__stat" }, `${mv} matrix leg${mv === "1" ? "" : "s"}`),
  );
  bar.append(totals);
  mount.append(bar);

  const banner = bannerNode(report);
  if (banner) mount.append(banner);

  const list = el("div", { class: "wf-list" });
  for (const wf of report.workflows) list.append(workflowNode(wf));
  mount.append(list);
}

/** Render a hard engine error (should be rare — parse errors surface as verdicts). */
export function renderError(message: string, mount: HTMLElement): void {
  clear(mount);
  mount.append(
    el(
      "div",
      { class: "banner banner--nothing", role: "status" },
      el(
        "div",
        { class: "banner__head" },
        el("span", { class: "banner__glyph", "aria-hidden": "true" }, "✖"),
        el("span", { class: "banner__title" }, "Could not evaluate"),
      ),
      el("p", { class: "banner__sub" }, message),
    ),
  );
}
