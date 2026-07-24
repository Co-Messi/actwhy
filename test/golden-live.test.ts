/**
 * LIVE-FIDELITY TRUST ANCHOR (runnable).
 *
 * On 2026-07-24 twelve crafted workflows were pushed to a scratch GitHub repo
 * across a set of ref events, and the workflows GitHub *actually ran* were
 * recorded via the Actions REST API into `test/golden/live-runs-raw.json`.
 *
 * This test replays every one of those events through actwhy's engine and
 * asserts the fired set EXACTLY matches what real GitHub did. It MUST FAIL if
 * the engine ever diverges from recorded real-GitHub behavior (e.g. a
 * regression in the `?`/`+` quantifier semantics, `!` negation ordering,
 * paths-ignore "skip only if ALL ignored", tag-vs-branch filter rules, or the
 * mixed-template `if:` footgun).
 *
 * The 12 probe workflow YAMLs below are INLINED verbatim from the scratch
 * repo's `.github/workflows/` (the scratch dir is ephemeral). They mirror the
 * behavior recorded in `test/golden/live-runs-raw.json`. NOTE: the repo ships
 * 11 `q*.yml` files (q1..q11); the golden README's "12 workflows / 13 ref
 * events" counts are off-by-one — there are 11 workflow files and 12 ref
 * events (7 branch pushes incl. the negative probe v3.0, 4 main commits, 1
 * tag). The `main` commit→sha key is taken from test/golden/README.md:
 *   9161036 = c1 (src+docs+workflows), 638fe3a = c2 (docs/x.md only),
 *   62bd194 = c3 (docs/keep.md only), 1ea22e9 = c4 (src only).
 * (c1 and c4 both touch src, so they share an identical fired set — the
 * c1<->c4 sha choice is assertion-neutral.)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateWorkflows } from "../src/core/index.js";
import type { PushSpec, Report, WorkflowFile } from "../src/core/types.js";

// ── inlined probe workflows (verbatim from the scratch repo) ──────────────

const Q1_STAR = `name: q1-star
on:
  push:
    branches: ['feature/*']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q2_DSTAR = `name: q2-dstar
on:
  push:
    branches: ['feature/**']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q3_QMARK = `name: q3-qmark
on:
  push:
    branches: ['ab?']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q4_PLUS = `name: q4-plus
on:
  push:
    branches: ['ab+']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q5_PNEG = `name: q5-pneg
on:
  push:
    branches: [main]
    paths: ['**', '!docs/**']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q6_REINC = `name: q6-reinc
on:
  push:
    branches: [main]
    paths: ['**', '!docs/**', 'docs/keep.md']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q7_PIGN = `name: q7-pign
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q8_BRONLY = `name: q8-bronly
on:
  push:
    branches: [main]
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const Q9_TAGS = `name: q9-tags
on:
  push:
    tags: ['v*']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

// NOTE: `\${{` is escaped so the template literal does not interpolate — the
// first two conditions deliberately mix `${{ }}` and literal text.
const Q10_IFS = `name: q10-ifs
on:
  push:
    branches: [main]
jobs:
  footgun:
    if: \${{ github.ref }} == 'refs/heads/never'
    runs-on: ubuntu-latest
    steps: [{run: echo footgun-ran}]
  emptynull:
    if: \${{ '' == null }}
    runs-on: ubuntu-latest
    steps: [{run: echo emptynull-ran}]
  falsy:
    if: github.ref == 'refs/heads/never'
    runs-on: ubuntu-latest
    steps: [{run: echo should-not-run}]
`;

const Q11_CLASS = `name: q11-class
on:
  push:
    branches: ['v[12].[0-9]+']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}
`;

const WORKFLOWS: WorkflowFile[] = [
  { name: "q1-star.yml", content: Q1_STAR },
  { name: "q2-dstar.yml", content: Q2_DSTAR },
  { name: "q3-qmark.yml", content: Q3_QMARK },
  { name: "q4-plus.yml", content: Q4_PLUS },
  { name: "q5-pneg.yml", content: Q5_PNEG },
  { name: "q6-reinc.yml", content: Q6_REINC },
  { name: "q7-pign.yml", content: Q7_PIGN },
  { name: "q8-bronly.yml", content: Q8_BRONLY },
  { name: "q9-tags.yml", content: Q9_TAGS },
  { name: "q10-ifs.yml", content: Q10_IFS },
  { name: "q11-class.yml", content: Q11_CLASS },
];

// ── golden data (recorded real-GitHub runs) ───────────────────────────────

interface GoldenRun {
  event: string;
  ref: string;
  sha: string;
  workflow: string;
}

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "golden",
  "live-runs-raw.json",
);
const GOLDEN = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenRun[];

/** Map "<ref>@<sha>" → set of workflow names GitHub actually ran. */
const goldenFired = new Map<string, Set<string>>();
for (const run of GOLDEN) {
  const key = `${run.ref}@${run.sha}`;
  if (!goldenFired.has(key)) goldenFired.set(key, new Set());
  goldenFired.get(key)!.add(run.workflow);
}

/** Workflows the engine fires, as bare names (no `.yml`), to compare to golden. */
function firedNames(report: Report): Set<string> {
  return new Set(
    report.workflows
      .filter((w) => w.verdict === "fires")
      .map((w) => w.file.replace(/\.ya?ml$/, "")),
  );
}

const sorted = (s: Set<string>): string[] => [...s].sort();

// A representative superset for c1: src + docs + workflow files touched.
const C1_FILES = [
  "src/base.txt",
  "docs/keep.md",
  "docs/x.md",
  ".github/workflows/q1-star.yml",
  ".github/workflows/q10-ifs.yml",
];

interface ProbeEvent {
  label: string;
  /** golden lookup ref (branch or tag short name). */
  ref: string;
  /** golden lookup sha. */
  sha: string;
  spec: PushSpec;
}

// The 12 ref events. Branch probes have no paths filters on the workflows
// they exercise, so `files: null` is fine. All branch probes were pushed at
// the same commit (1ea22e9) in the golden run.
const BRANCH_SHA = "1ea22e9";
const EVENTS: ProbeEvent[] = [
  // 7 branch pushes (incl. the negative probe v3.0, which fired nothing) ----
  { label: "branch feature/x", ref: "feature/x", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "feature/x", files: null, sha: BRANCH_SHA } },
  { label: "branch feature/deep/y", ref: "feature/deep/y", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "feature/deep/y", files: null, sha: BRANCH_SHA } },
  { label: "branch a", ref: "a", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "a", files: null, sha: BRANCH_SHA } },
  { label: "branch ab", ref: "ab", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "ab", files: null, sha: BRANCH_SHA } },
  { label: "branch abb", ref: "abb", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "abb", files: null, sha: BRANCH_SHA } },
  { label: "branch v1.10", ref: "v1.10", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "v1.10", files: null, sha: BRANCH_SHA } },
  // v3.0 is NOT in the golden data — it must fire nothing (negative probe).
  { label: "branch v3.0 (negative probe)", ref: "v3.0", sha: BRANCH_SHA,
    spec: { kind: "push", branch: "v3.0", files: null, sha: BRANCH_SHA } },

  // 4 main commits with disjoint changed-file sets -------------------------
  { label: "main c1 (src+docs+workflows)", ref: "main", sha: "9161036",
    spec: { kind: "push", branch: "main", files: C1_FILES, sha: "9161036" } },
  { label: "main c2 (docs/x.md only)", ref: "main", sha: "638fe3a",
    spec: { kind: "push", branch: "main", files: ["docs/x.md"], sha: "638fe3a" } },
  { label: "main c3 (docs/keep.md only)", ref: "main", sha: "62bd194",
    spec: { kind: "push", branch: "main", files: ["docs/keep.md"], sha: "62bd194" } },
  { label: "main c4 (src/base.txt only)", ref: "main", sha: "1ea22e9",
    spec: { kind: "push", branch: "main", files: ["src/base.txt"], sha: "1ea22e9" } },

  // 1 tag push -------------------------------------------------------------
  { label: "tag v1.0.0", ref: "v1.0.0", sha: BRANCH_SHA,
    spec: { kind: "push", tag: "v1.0.0", files: null, sha: BRANCH_SHA } },
];

describe("live-fidelity trust anchor: engine matches recorded real-GitHub runs", () => {
  const consumedKeys = new Set<string>();

  for (const ev of EVENTS) {
    it(`${ev.label} → fired set matches golden`, async () => {
      const report = await evaluateWorkflows(WORKFLOWS, ev.spec);
      const actual = firedNames(report);

      const key = `${ev.ref}@${ev.sha}`;
      consumedKeys.add(key);
      const expected = goldenFired.get(key) ?? new Set<string>();

      // EXACT match — extra or missing firings both fail.
      expect(sorted(actual)).toEqual(sorted(expected));
    });
  }

  it("v3.0 is a genuine nothing-fires (negative probe absent from golden)", async () => {
    const v30 = EVENTS.find((e) => e.ref === "v3.0")!;
    const report = await evaluateWorkflows(WORKFLOWS, v30.spec);
    expect(firedNames(report).size).toBe(0);
    expect(report.nothingFires).toBe(true);
    // ensure golden truly has no v3.0 record (guards the negative assertion)
    expect(GOLDEN.some((r) => r.ref === "v3.0")).toBe(false);
  });

  it("every recorded golden run is consumed by exactly one replayed event", async () => {
    // Run all events so consumedKeys is populated regardless of `it` order.
    for (const ev of EVENTS) {
      await evaluateWorkflows(WORKFLOWS, ev.spec);
      consumedKeys.add(`${ev.ref}@${ev.sha}`);
    }
    for (const key of goldenFired.keys()) {
      expect(consumedKeys.has(key), `golden key "${key}" was never replayed`).toBe(true);
    }
    // Sanity: golden isn't empty and covers the expected number of run-groups.
    expect(goldenFired.size).toBe(11); // 6 branch + 4 main + 1 tag groups that fired
  });
});

// ── q10-ifs job-level `if:` fidelity (the cases most tools get wrong) ──────

describe("q10-ifs job-level `if:` decisions match GitHub", () => {
  it("footgun job RUNS (mixed template is always-true) + workflow warns; emptynull RUNS; falsy SKIPPED", async () => {
    const spec: PushSpec = {
      kind: "push",
      branch: "main",
      files: C1_FILES,
      sha: "9161036",
    };
    const report = await evaluateWorkflows(WORKFLOWS, spec);
    const q10 = report.workflows.find((w) => w.file === "q10-ifs.yml")!;
    expect(q10.verdict).toBe("fires");

    const jobById = (id: string) => q10.jobs.find((j) => j.id === id)!;

    // `if: ${{ github.ref }} == 'refs/heads/never'` compiles to a non-empty
    // STRING → always truthy → GitHub ran it. actwhy: fires + footgun warning.
    expect(jobById("footgun").verdict).toBe("fires");
    expect(q10.warnings.map((w) => w.code)).toContain("always-true-if");

    // `if: ${{ '' == null }}` → GitHub coercion makes it true → ran.
    expect(jobById("emptynull").verdict).toBe("fires");

    // `if: github.ref == 'refs/heads/never'` → plain false on a main push.
    expect(jobById("falsy").verdict).toBe("skipped");
  });
});
