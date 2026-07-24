/**
 * Regression locks for the Medium/Low adversarial-review fixes.
 *
 * Core-level fixes are exercised directly through `evaluateWorkflows`; the two
 * CLI-surface fixes (`--event` validation, `--exit-code` contract) go through
 * the real built binary. The CLI is bundled with esbuild to a PRIVATE temp path
 * (never the shared dist/actwhy.js) so parallel workers can't truncate each
 * other's binary mid-read -- same pattern as test/e2e-event.ts.
 *
 * Warning codes and exit codes here were confirmed against src/core + src/cli,
 * not assumed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build as esbuild } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateWorkflows } from "../src/core/index.js";
import type { PushSpec, WorkflowFile } from "../src/core/types.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const file = (name: string, content: string): WorkflowFile => ({ name, content });
const mainPush: PushSpec = { kind: "push", branch: "main", files: [] };

/** A YAML flow sequence of `n` distinct scalar values, e.g. "[v0, v1, v2]". */
function axisList(n: number): string {
  return "[" + Array.from({ length: n }, (_, i) => `v${i}`).join(", ") + "]";
}

/** A one-job workflow whose matrix is `a` x `b` static combos. */
function matrixWorkflow(a: number, b: number): string {
  return [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    strategy:",
    "      matrix:",
    `        a: ${axisList(a)}`,
    `        b: ${axisList(b)}`,
    "    steps: [{run: echo}]",
    "",
  ].join("\n");
}

// ── Matrix 256 hard cap ─────────────────────────────────────────────────────

describe("matrix over-limit error (GitHub's 256-job cap)", () => {
  it("marks a matrix that expands to >256 static combos as an error", async () => {
    // 17 x 16 = 272 > 256.
    const report = await evaluateWorkflows([file("m.yml", matrixWorkflow(17, 16))], mainPush);
    const w = report.workflows[0];
    expect(w.verdict).toBe("fires");

    // The job is retained for diagnosis, but it cannot truthfully be counted
    // as firing because GitHub rejects the expansion.
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0].verdict).toBe("error");
    expect(w.jobs[0].reasons.map((r) => r.code)).toContain("matrix-over-limit");
    expect(w.jobs[0].matrix).toBe(272);
    expect(report.summary.jobsFiring).toBe(0);
    expect(report.summary.matrixVariantsFiring).toBe(0);
  });

  it("does NOT warn when the matrix is exactly 256 (at the cap, not over it)", async () => {
    // 16 x 16 = 256, exactly the limit.
    const report = await evaluateWorkflows([file("m.yml", matrixWorkflow(16, 16))], mainPush);
    const w = report.workflows[0];
    expect(w.jobs[0].matrix).toBe(256);
    expect(w.jobs[0].verdict).toBe("fires");
  });
});

// ── paths + paths-ignore both set ───────────────────────────────────────────

describe("paths and paths-ignore both set on one event", () => {
  it("warns and follows `paths` (paths-ignore dropped, matching GitHub)", async () => {
    const content = [
      "on:",
      "  push:",
      "    branches: [main]",
      "    paths: ['src/**']",
      "    paths-ignore: ['**']", // would ignore EVERYTHING if GitHub honored it
      "jobs:",
      "  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}",
      "",
    ].join("\n");
    // src/app.ts matches `paths`; if paths-ignore were applied, all files would
    // be ignored and the workflow would skip. It fires -> paths won.
    const spec: PushSpec = { kind: "push", branch: "main", files: ["src/app.ts"] };
    const report = await evaluateWorkflows([file("p.yml", content)], spec);
    const w = report.workflows[0];

    expect(w.verdict).toBe("fires");
    expect(w.warnings.some((r) => r.code === "paths-and-paths-ignore")).toBe(true);
  });
});

// ── workflow name resolution ────────────────────────────────────────────────

describe("workflow name", () => {
  it("captures a top-level `name:` onto the verdict", async () => {
    const content = "name: My Cool CI\non: push\njobs:\n  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n";
    const report = await evaluateWorkflows([file("n.yml", content)], mainPush);
    expect(report.workflows[0].name).toBe("My Cool CI");
  });

  it("leaves `.name` undefined when the workflow has no `name:`", async () => {
    const content = "on: push\njobs:\n  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n";
    const report = await evaluateWorkflows([file("u.yml", content)], mainPush);
    expect(report.workflows[0].name).toBeUndefined();
  });
});

// ── prototype-pollution hardening on the --event payload merge ───────────────

describe("event payload merge cannot pollute Object.prototype", () => {
  it("ignores a top-level __proto__ key and never touches the global prototype", async () => {
    const content = "on:\n  push:\n    branches: [main]\njobs:\n  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n";
    // JSON.parse makes __proto__ an OWN key (it does not set the prototype);
    // the merge must skip it. The workflow must FIRE so the merge path runs.
    const payload = JSON.parse('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
    const report = await evaluateWorkflows([file("pp.yml", content)], {
      ...mainPush,
      payload,
    });
    expect(report.workflows[0].verdict).toBe("fires");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores a NESTED __proto__ inside an existing payload subtree", async () => {
    const content = "on:\n  push:\n    branches: [main]\njobs:\n  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n";
    // `repository` is a mergeable subtree, so this exercises the recursive path.
    const payload = JSON.parse('{"repository":{"__proto__":{"polluted2":1}}}') as Record<string, unknown>;
    await evaluateWorkflows([file("pp.yml", content)], { ...mainPush, payload });
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });
});

// ── CLI-surface fixes: --event validation + --exit-code contract ─────────────

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let binPath: string;
let workDir: string;
let repoValid: string;
let repoInvalid: string;
let evtArray: string;
let evtString: string;
let evtMalformed: string;
let evtProto: string;

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [binPath, ...args], { cwd: workDir }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Base args pin branch + files so any exit-2 is attributable to --event, not git. */
const base = (repo: string): string[] => ["push", "-C", repo, "--branch", "main", "--files", "x"];

beforeAll(async () => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "actwhy-roast-")));
  binPath = join(workDir, "actwhy.js");

  await esbuild({
    entryPoints: [join(projectRoot, "src", "cli", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: binPath,
    logLevel: "silent",
    define: { ACTWHY_VERSION: JSON.stringify("test") },
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        "const require = __cr(import.meta.url);",
      ].join("\n"),
    },
  });

  // A repo whose sole workflow fires on push to main; branch feature -> nothing.
  repoValid = join(workDir, "valid");
  mkdirSync(join(repoValid, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repoValid, ".github", "workflows", "ci.yml"),
    "on:\n  push:\n    branches: [main]\njobs:\n  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n",
  );

  // A repo whose sole workflow is unparseable YAML (probe-confirmed: verdict error).
  repoInvalid = join(workDir, "invalid");
  mkdirSync(join(repoInvalid, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repoInvalid, ".github", "workflows", "bad.yml"), "on: push\njobs: {");

  evtArray = join(workDir, "arr.json");
  evtString = join(workDir, "str.json");
  evtMalformed = join(workDir, "bad.json");
  evtProto = join(workDir, "proto.json");
  writeFileSync(evtArray, "[1, 2, 3]");
  writeFileSync(evtString, '"just a string"');
  writeFileSync(evtMalformed, "{ this is not valid json");
  writeFileSync(evtProto, '{"__proto__":{"polluted":1}}');
}, 120_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("--event payload validation (CLI)", () => {
  it("a JSON array payload -> exit 2 with 'must contain a JSON object'", async () => {
    const { code, stderr } = await runCli([...base(repoValid), "--event", evtArray]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/must contain a JSON object/);
  }, 30_000);

  it("a bare JSON string payload -> exit 2 with 'must contain a JSON object'", async () => {
    const { code, stderr } = await runCli([...base(repoValid), "--event", evtString]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/must contain a JSON object/);
  }, 30_000);

  it("malformed JSON -> exit 2 with 'invalid JSON in event file'", async () => {
    const { code, stderr } = await runCli([...base(repoValid), "--event", evtMalformed]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/invalid JSON in event file/);
  }, 30_000);

  it("a __proto__-bearing object payload runs cleanly (exit 0, no crash)", async () => {
    const { code } = await runCli([...base(repoValid), "--event", evtProto]);
    expect(code).toBe(0);
  }, 30_000);
});

describe("--exit-code contract (CLI)", () => {
  it("something fires -> exit 0 (with and without --exit-code)", async () => {
    expect((await runCli(base(repoValid))).code).toBe(0);
    expect((await runCli([...base(repoValid), "--exit-code"])).code).toBe(0);
  }, 30_000);

  it("nothing fires -> exit 4 with --exit-code, but 0 without it", async () => {
    const nothing = ["push", "-C", repoValid, "--branch", "feature", "--files", "x"];
    expect((await runCli(nothing)).code).toBe(0);
    expect((await runCli([...nothing, "--exit-code"])).code).toBe(4);
  }, 30_000);

  it("an invalid workflow -> exit 3 with --exit-code, but 0 without it", async () => {
    expect((await runCli(base(repoInvalid))).code).toBe(0);
    expect((await runCli([...base(repoInvalid), "--exit-code"])).code).toBe(3);
  }, 30_000);
});
