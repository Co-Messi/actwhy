import { describe, it, expect } from "vitest";
import { evaluateWorkflows } from "../src/core/index.js";
import type {
  PushSpec,
  PrSpec,
  Report,
  WorkflowVerdict,
  JobVerdict,
} from "../src/core/types.js";

// ── helpers ─────────────────────────────────────────────────────────────

const file = (name: string, content: string) => ({ name, content });

function wf(report: Report, name: string): WorkflowVerdict {
  const w = report.workflows.find((x) => x.file === name);
  if (!w) throw new Error(`workflow "${name}" not in report`);
  return w;
}

function job(workflow: WorkflowVerdict, id: string): JobVerdict {
  const j = workflow.jobs.find((x) => x.id === id);
  if (!j) throw new Error(`job "${id}" not in workflow ${workflow.file}`);
  return j;
}

const codes = (rs: { code: string }[]): string[] => rs.map((r) => r.code);

// ── shared fixtures ─────────────────────────────────────────────────────

const CI_YAML = `
name: CI
on:
  push:
    branches: [main, 'releases/**']
    paths: ['src/**', 'package.json', '!src/vendor/**']
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu, macos]
        node: [18, 20, 22]
        exclude: [{os: macos, node: 18}]
    steps: [{run: echo build}]
  test:
    needs: build
    runs-on: ubuntu-latest
    steps: [{run: echo test}]
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps: [{run: echo deploy}]
  notify:
    needs: [build, test]
    if: failure()
    runs-on: ubuntu-latest
    steps: [{run: echo notify}]
  gated:
    if: vars.DEPLOY_ENV == 'production'
    runs-on: ubuntu-latest
    steps: [{run: echo gated}]
`;

// Classic mixed-template footgun — always truthy. Reused to make a second
// workflow fire (so the report-level matrixVariantsFiring reaches 8).
const FOOTGUN_YAML = `
name: Footgun
on: push
jobs:
  oops:
    if: \${{ github.ref }} == 'refs/heads/never'
    runs-on: ubuntu-latest
    steps: [{run: echo oops}]
`;

// ── (a) CI workflow ──────────────────────────────────────────────────────

describe("(a) CI workflow with branches/paths, matrix, needs & if-gates", () => {
  const files = [file("ci.yml", CI_YAML), file("footgun.yml", FOOTGUN_YAML)];

  it("push main src/index.ts → fires; build/test/deploy fire, notify failure-gated, gated unknown, matrix=8", async () => {
    const spec: PushSpec = {
      kind: "push",
      branch: "main",
      files: ["src/index.ts"],
      repository: "me/repo",
    };
    const report = await evaluateWorkflows(files, spec);
    const ci = wf(report, "ci.yml");

    expect(ci.verdict).toBe("fires");
    expect(job(ci, "build").verdict).toBe("fires");
    expect(job(ci, "build").matrix).toBe(5);
    expect(job(ci, "test").verdict).toBe("fires");
    expect(job(ci, "deploy").verdict).toBe("fires");

    const notify = job(ci, "notify");
    expect(notify.verdict).toBe("skipped");
    expect(codes(notify.reasons)).toContain("failure-gated");

    const gated = job(ci, "gated");
    expect(gated.verdict).toBe("unknown");
    expect(codes(gated.reasons)).toContain("if-unknown");

    // report-level: build(5) + test(1) + deploy(1) + footgun.oops(1) = 8
    expect(report.summary.matrixVariantsFiring).toBe(8);
  });

  it("push main src/vendor/lib.js → skipped: paths negation excludes the vendored file", async () => {
    const spec: PushSpec = {
      kind: "push",
      branch: "main",
      files: ["src/vendor/lib.js"],
    };
    const ci = wf(await evaluateWorkflows(files, spec), "ci.yml");
    expect(ci.verdict).toBe("skipped");
    expect(codes(ci.reasons)).toContain("paths-filter-no-match");
  });

  it("push feat/x src/index.ts → skipped: branch filter no match", async () => {
    const spec: PushSpec = {
      kind: "push",
      branch: "feat/x",
      files: ["src/index.ts"],
    };
    const ci = wf(await evaluateWorkflows(files, spec), "ci.yml");
    expect(ci.verdict).toBe("skipped");
    expect(codes(ci.reasons)).toContain("branch-filter-no-match");
  });

  it("pull_request base main → fires; deploy skipped because event_name is pull_request", async () => {
    const spec: PrSpec = {
      kind: "pull_request",
      base: "main",
      head: "feat/x",
      files: ["src/a.ts"],
    };
    const ci = wf(await evaluateWorkflows(files, spec), "ci.yml");
    expect(ci.verdict).toBe("fires");

    const deploy = job(ci, "deploy");
    expect(deploy.verdict).toBe("skipped");
    // the explanation should point at github.event_name being pull_request
    const detail = deploy.reasons.map((r) => r.detail ?? "").join(" ");
    expect(detail).toContain("github.event_name");
  });

  it("push tag v1.0.0 → skipped: branch-only filters never match a tag push", async () => {
    const spec: PushSpec = { kind: "push", tag: "v1.0.0", files: [] };
    const ci = wf(await evaluateWorkflows(files, spec), "ci.yml");
    expect(ci.verdict).toBe("skipped");
    expect(codes(ci.reasons)).toContain("tag-push-branch-filters-only");
  });
});

// ── (b) paths-ignore ─────────────────────────────────────────────────────

describe("(b) paths-ignore workflow", () => {
  const files = [
    file(
      "pi.yml",
      `
on:
  push:
    paths-ignore: ['docs/**', '*.md']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
    ),
  ];

  it("skips when every changed file is ignored", async () => {
    const spec: PushSpec = {
      kind: "push",
      branch: "main",
      files: ["docs/a.md", "README.md"],
    };
    const w = wf(await evaluateWorkflows(files, spec), "pi.yml");
    expect(w.verdict).toBe("skipped");
    expect(codes(w.reasons)).toContain("paths-all-ignored");
  });

  it("fires when at least one changed file escapes the ignore list", async () => {
    const spec: PushSpec = {
      kind: "push",
      branch: "main",
      files: ["docs/a.md", "src/x.ts"],
    };
    const w = wf(await evaluateWorkflows(files, spec), "pi.yml");
    expect(w.verdict).toBe("fires");
  });
});

// ── (c) workflow_dispatch only ───────────────────────────────────────────

describe("(c) workflow_dispatch-only workflow", () => {
  it("a push is skipped and the reason detail mentions manual dispatch", async () => {
    const files = [
      file(
        "wd.yml",
        `
on:
  workflow_dispatch:
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const w = wf(await evaluateWorkflows(files, spec), "wd.yml");
    expect(w.verdict).toBe("skipped");
    const detail = w.reasons.map((r) => r.detail ?? "").join(" ").toLowerCase();
    expect(detail).toMatch(/manual|dispatch/);
  });
});

// ── (d) needs-skip propagation ───────────────────────────────────────────

describe("(d) needs-skip propagation down the DAG", () => {
  it("skipping `a` propagates to b and c, but an always() job d still fires", async () => {
    const files = [
      file(
        "n.yml",
        `
on: push
jobs:
  a:
    if: github.ref == 'refs/heads/never'
    runs-on: ubuntu-latest
    steps: [{run: echo a}]
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{run: echo b}]
  c:
    needs: b
    runs-on: ubuntu-latest
    steps: [{run: echo c}]
  d:
    needs: a
    if: always()
    runs-on: ubuntu-latest
    steps: [{run: echo d}]
`,
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: null };
    const w = wf(await evaluateWorkflows(files, spec), "n.yml");

    // a's own if is false (ref is main, not "never")
    expect(job(w, "a").verdict).toBe("skipped");

    const b = job(w, "b");
    expect(b.verdict).toBe("skipped");
    expect(codes(b.reasons)).toContain("needs-skipped");

    const c = job(w, "c");
    expect(c.verdict).toBe("skipped");
    expect(codes(c.reasons)).toContain("needs-skipped");

    // always() ignores the skipped dependency
    expect(job(w, "d").verdict).toBe("fires");
  });
});

// ── (e) always-true `if:` footgun ────────────────────────────────────────

describe("(e) mixed-template `if:` footgun", () => {
  it("the job FIRES and the workflow emits an always-true-if warning", async () => {
    const files = [file("fg.yml", FOOTGUN_YAML)];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const w = wf(await evaluateWorkflows(files, spec), "fg.yml");

    expect(w.verdict).toBe("fires");
    expect(job(w, "oops").verdict).toBe("fires");
    expect(codes(w.warnings)).toContain("always-true-if");
  });
});

// ── (f) invalid workflow ─────────────────────────────────────────────────

describe("(f) invalid workflow", () => {
  it("broken YAML (unclosed brackets) yields an error verdict", async () => {
    const files = [file("bad.yml", `on: [push\njobs: {`)];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const w = wf(await evaluateWorkflows(files, spec), "bad.yml");
    expect(w.verdict).toBe("error");
    expect(w.reasons.length).toBeGreaterThan(0);
  });
});

// ── (g) nothing fires ────────────────────────────────────────────────────

describe("(g) nothing fires", () => {
  it("reports nothingFires with a closestMiss pointing at the branch filter", async () => {
    const files = [
      file(
        "only.yml",
        `
on:
  push:
    branches: [main]
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "feat", files: [] };
    const report = await evaluateWorkflows(files, spec);

    expect(report.nothingFires).toBe(true);
    expect(report.closestMiss?.file).toBe("only.yml");
    expect(report.closestMiss?.reason.code).toBe("branch-filter-no-match");
  });
});

// ── (h) unknown changed files ────────────────────────────────────────────

describe("(h) files=null with a paths filter", () => {
  it("yields an unknown verdict rather than guessing", async () => {
    const files = [
      file(
        "h.yml",
        `
on:
  push:
    branches: [main]
    paths: ['src/**']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: null };
    const w = wf(await evaluateWorkflows(files, spec), "h.yml");
    expect(w.verdict).toBe("unknown");
    expect(codes(w.reasons)).toContain("changed-files-unknown");
  });
});

// ── (i) matrix include semantics ─────────────────────────────────────────

describe("(i) matrix include: new combo vs. extend-only", () => {
  const withMatrix = (matrixYaml: string) =>
    `
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    strategy:
      matrix:
${matrixYaml}
    steps: [{run: echo}]
`;

  it("an include entry that introduces a new axis value adds a variant (2 → 3)", async () => {
    const files = [
      file(
        "m.yml",
        withMatrix(`        os: [a, b]
        include:
          - os: c`),
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: null };
    const w = wf(await evaluateWorkflows(files, spec), "m.yml");
    expect(job(w, "j").matrix).toBe(3);
  });

  it("an include entry that only extends an existing combo adds no variant (stays 2)", async () => {
    const files = [
      file(
        "m.yml",
        withMatrix(`        os: [a, b]
        include:
          - os: a
            extra: x`),
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: null };
    const w = wf(await evaluateWorkflows(files, spec), "m.yml");
    expect(job(w, "j").matrix).toBe(2);
  });
});

// ── (j) tag push with tags filter ────────────────────────────────────────

describe("(j) push trigger with tags filter only", () => {
  const files = [
    file(
      "t.yml",
      `
on:
  push:
    tags: ['v*']
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
    ),
  ];

  it("a matching tag push fires", async () => {
    const spec: PushSpec = { kind: "push", tag: "v1.0.0", files: [] };
    const w = wf(await evaluateWorkflows(files, spec), "t.yml");
    expect(w.verdict).toBe("fires");
  });

  it("a branch push is skipped because only tag filters are defined", async () => {
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const w = wf(await evaluateWorkflows(files, spec), "t.yml");
    expect(w.verdict).toBe("skipped");
    expect(codes(w.reasons)).toContain("branch-push-tag-filters-only");
  });
});

// ── (k) pull_request activity types ──────────────────────────────────────

describe("(k) pull_request activity types", () => {
  it("an activity type outside an explicit `types` list is skipped", async () => {
    const files = [
      file(
        "p.yml",
        `
on:
  pull_request:
    types: [labeled]
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
      ),
    ];
    const spec: PrSpec = {
      kind: "pull_request",
      base: "main",
      files: [],
      activityType: "opened",
    };
    const w = wf(await evaluateWorkflows(files, spec), "p.yml");
    expect(w.verdict).toBe("skipped");
    expect(codes(w.reasons)).toContain("activity-type-no-match");
  });

  it("an activity type outside the DEFAULT set is skipped", async () => {
    const files = [
      file(
        "p.yml",
        `
on: pull_request
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
      ),
    ];
    const spec: PrSpec = {
      kind: "pull_request",
      base: "main",
      files: [],
      activityType: "labeled",
    };
    const w = wf(await evaluateWorkflows(files, spec), "p.yml");
    expect(w.verdict).toBe("skipped");
    expect(codes(w.reasons)).toContain("activity-type-no-match");
  });
});

// ── (l) bare `on: push` ──────────────────────────────────────────────────

describe("(l) bare `on: push`", () => {
  it("fires for any branch", async () => {
    const files = [
      file(
        "b.yml",
        `
on: push
jobs:
  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}
`,
      ),
    ];
    const spec: PushSpec = {
      kind: "push",
      branch: "some/random/branch",
      files: [],
    };
    const w = wf(await evaluateWorkflows(files, spec), "b.yml");
    expect(w.verdict).toBe("fires");
  });
});
