/**
 * Regression lock for the HIGH fix: `renderReport` strips terminal control
 * characters (C0 / DEL / C1, including ESC 0x1b) from every attacker-derived
 * string before rendering. Workflow files come from repos the user did not
 * write; a branch name or filter pattern carrying `\x1b[32m` could otherwise
 * repaint a SKIPPED line as a green FIRES -- forging the one output this tool
 * must keep unforgeable.
 *
 * Strategy (per the reviewer's construction rules):
 *   - Every "ESC is gone" negative assertion is paired with a POSITIVE marker
 *     assertion, so a field that never actually renders can't pass vacuously.
 *   - The report shapes force each listed field into the output (job fields
 *     render only on a firing workflow; closestMiss only when nothingFires;
 *     filesSource only when there are changed files; a reason detail on a
 *     skipped workflow; a multiline message on an error workflow).
 *   - Control chars are written as unambiguous \u escapes and matched with raw
 *     `.includes(...)` -- sanitize also strips a LONE ESC, so requiring a full
 *     `\x1b[` sequence would under-check.
 */

import { describe, it, expect } from "vitest";
import { evaluateWorkflows } from "../src/core/index.js";
import type {
  JobVerdict,
  PushSpec,
  Reason,
  Report,
  ReportSummary,
  WorkflowVerdict,
} from "../src/core/types.js";
import { renderReport } from "../src/cli/render.js";

const ESC = "\u001b"; // 0x1B -- begins every ANSI SGR sequence
const BELL = "\u0007"; // 0x07 -- C0 bell
const CSI = "\u009b"; // 0x9B -- C1 control sequence introducer
/** Strips only picocolors' LEGITIMATE color escapes (ESC [ ... m). */
const STRIP_SGR = new RegExp(ESC + "\\[[0-9;]*m", "g");

const reason = (code: string, message: string, detail?: string): Reason =>
  detail === undefined ? { code, message } : { code, message, detail };

/** A summary is 7 required numbers; supply sane defaults, override as needed. */
const summary = (over: Partial<ReportSummary> = {}): ReportSummary => ({
  workflowsTotal: 1,
  workflowsFiring: 0,
  workflowsSkipped: 0,
  workflowsUnknown: 0,
  workflowsError: 0,
  jobsFiring: 0,
  matrixVariantsFiring: 0,
  ...over,
});

/** Assert the three control-char families are absent from rendered output. */
function expectNoControlChars(out: string): void {
  expect(out.includes(ESC), "ESC (0x1b) must be stripped").toBe(false);
  expect(out.includes(BELL), "bell (0x07) must be stripped").toBe(false);
  expect(out.includes(CSI), "CSI (0x9b) must be stripped").toBe(false);
}

// -- skipped workflow: file name, reason message + detail, warning, header
//    (branch + filesSource), and the closest-miss line ----------------------

describe("renderReport sanitizes a skipped workflow + header + closest miss", () => {
  const report: Report = {
    event: {
      kind: "push",
      branch: `main${ESC}[32m FORGEDBRANCH`,
      files: ["src/x.ts"], // length 1 -> filesSource is rendered
    } as PushSpec,
    workflows: [
      {
        file: `ci.yml${ESC}[7mFORGEDFILE`,
        verdict: "skipped",
        reasons: [
          reason(
            "branch-filter-no-match",
            `branch filter mismatch ${ESC}[32m${BELL}FORGEDREASON${CSI}`,
            `compared values ${ESC}[33mFORGEDDETAIL`,
          ),
        ],
        warnings: [reason("some-warn", `a warning ${ESC}[35mFORGEDWARN`)],
        jobs: [],
      },
    ],
    summary: summary({ workflowsSkipped: 1 }),
    nothingFires: true,
    closestMiss: {
      file: `ci.yml${ESC}FORGEDMISSFILE`,
      reason: reason("branch-filter-no-match", `closest ${ESC}[32mFORGEDMISS`),
    },
  };
  const opts = { color: false, filesSource: `from --files${ESC}[31mFORGEDSRC` };

  it("removes every control char yet keeps each field's visible text", () => {
    const out = renderReport(report, opts);
    expectNoControlChars(out);
    // Positive markers -- each proves its field actually reached the output.
    expect(out).toContain("FORGEDBRANCH"); // header branch
    expect(out).toContain("FORGEDFILE"); // workflow file name
    expect(out).toContain("FORGEDREASON"); // reason.message
    expect(out).toContain("FORGEDDETAIL"); // reason.detail
    expect(out).toContain("FORGEDWARN"); // warning message
    expect(out).toContain("FORGEDMISS"); // closestMiss reason
    expect(out).toContain("FORGEDSRC"); // filesSource
  });

  it("stays unforgeable in color mode too: only picocolors' own SGR remain", () => {
    const colored = renderReport(report, { ...opts, color: true });
    // Strip the renderer's LEGITIMATE color escapes; nothing injected survives.
    const residual = colored.replace(STRIP_SGR, "");
    expect(residual.includes(ESC), "no injected ESC beyond real SGR").toBe(false);
    expect(colored).toContain("FORGEDREASON");
  });
});

// -- firing workflow: job id, matrix note, step name, workflow warning -------

describe("renderReport sanitizes firing job / step / matrix-note fields", () => {
  const job: JobVerdict = {
    id: `deploy${ESC}[32mFORGEDJOBID`,
    verdict: "fires",
    reasons: [],
    needs: [],
    // matrix undefined + a matrixNote -> renderer prints "(<note>)".
    matrixNote: `reusable ${BELL}${CSI}${ESC}[36mFORGEDNOTE`,
    steps: [
      { index: 0, name: `build ${ESC}[4mFORGEDSTEP`, verdict: "fires", reasons: [] },
    ],
  };
  const report: Report = {
    event: { kind: "push", branch: "main", files: [] } as PushSpec,
    workflows: [
      {
        file: "ci.yml",
        verdict: "fires",
        reasons: [],
        warnings: [reason("w2", `late warning ${ESC}[35mFORGEDWARNB`)],
        jobs: [job],
      },
    ],
    summary: summary({ workflowsFiring: 1, jobsFiring: 1, matrixVariantsFiring: 1 }),
    nothingFires: false,
  };

  it("strips control chars from job id, matrix note, step name, and warning", () => {
    const out = renderReport(report, { color: false, steps: true });
    expectNoControlChars(out);
    expect(out).toContain("FORGEDJOBID");
    expect(out).toContain("FORGEDNOTE");
    expect(out).toContain("FORGEDSTEP");
    expect(out).toContain("FORGEDWARNB");
  });
});

// -- error workflow: ESC stripped, but legitimate \n and \t are PRESERVED -----

describe("renderReport preserves newlines/tabs in a parser error message", () => {
  const report: Report = {
    event: { kind: "push", branch: "main", files: [] } as PushSpec,
    workflows: [
      {
        file: "bad.yml",
        verdict: "error",
        reasons: [
          reason("parse-error", `line1 ${ESC}[31mFORGEDERR\nline2\twith-tab`),
        ],
        jobs: [],
        warnings: [],
      } as WorkflowVerdict,
    ],
    summary: summary({ workflowsError: 1 }),
    nothingFires: false,
  };

  it("drops ESC but keeps the newline (multiline layout) and the tab in the message", () => {
    const out = renderReport(report, { color: false });
    expect(out.includes(ESC)).toBe(false);
    expect(out).toContain("FORGEDERR");
    // The embedded newline splits the message across two indented lines.
    const lines = out.split("\n");
    expect(lines.some((l) => l.startsWith("    line1"))).toBe(true);
    expect(lines.some((l) => l.startsWith("    line2"))).toBe(true);
    // The tab survives verbatim (it is NOT a stripped control char).
    expect(out).toContain("line2\twith-tab");
  });
});

// -- authentic end-to-end: a real engine verdict carrying an ESC is sanitized -

describe("renderReport sanitizes a real evaluated report (not just literals)", () => {
  it("an ESC smuggled through the pushed branch is gone from reason + header", async () => {
    const files = [
      {
        name: "only.yml",
        content: `on:\n  push:\n    branches: [main]\njobs:\n  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`,
      },
    ];
    // The branch value is a JS string (no YAML control-char constraints); it
    // does not match "main", so the workflow is skipped and the reason quotes
    // the raw ref -- which must be sanitized on render.
    const spec: PushSpec = { kind: "push", branch: `main${ESC}[32mFORGEDLIVE`, files: [] };
    const report = await evaluateWorkflows(files, spec);
    const out = renderReport(report, { color: false });

    expect(report.workflows[0].verdict).toBe("skipped");
    expect(out.includes(ESC)).toBe(false);
    expect(out).toContain("FORGEDLIVE");
  });
});
