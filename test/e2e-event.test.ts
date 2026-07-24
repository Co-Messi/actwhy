/**
 * End-to-end coverage of the `--event <payload.json>` flag.
 *
 * A workflow gate that references a payload key actwhy cannot infer
 * (`github.event.forced`) must be UNKNOWN without --event, FIRE when a payload
 * supplies `forced:false`, and SKIP when the payload flips it to `true`. A
 * head_commit.message gate is decidable from the inferred commit message.
 * Malformed / missing payload files are usage errors (exit 2).
 *
 * The CLI is bundled here with esbuild to a PRIVATE temp path (not the shared
 * dist/actwhy.js) so parallel test workers that also build can't truncate each
 * other's binary mid-read.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build as esbuild } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report, JobVerdict } from "../src/core/types.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const WORKFLOW = `name: Event E2E
on:
  push:
    branches: [main]
jobs:
  message-gate:
    if: github.event.head_commit.message != null && !contains(github.event.head_commit.message, '[skip ci]')
    runs-on: ubuntu-latest
    steps: [{run: echo go}]
  forced-gate:
    if: github.event.forced == false
    runs-on: ubuntu-latest
    steps: [{run: echo forced}]
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let binPath: string;
let workDir: string;
let repoDir: string;
let payloadFalse: string;
let payloadTrue: string;
let payloadBad: string;

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

const job = (report: Report, id: string): JobVerdict => {
  const w = report.workflows.find((x) => x.file === "event.yml")!;
  return w.jobs.find((j) => j.id === id)!;
};

beforeAll(async () => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "actwhy-event-")));
  binPath = join(workDir, "actwhy.js");

  // Bundle the CLI to our private path (mirrors scripts/build.mjs minimally).
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

  repoDir = join(workDir, "repo");
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repoDir, ".github", "workflows", "event.yml"), WORKFLOW);

  payloadFalse = join(workDir, "forced-false.json");
  payloadTrue = join(workDir, "forced-true.json");
  payloadBad = join(workDir, "bad.json");
  writeFileSync(payloadFalse, JSON.stringify({ forced: false }));
  writeFileSync(payloadTrue, JSON.stringify({ forced: true }));
  writeFileSync(payloadBad, "{ this is not: valid json");
}, 120_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// Base args: a fixed branch + explicit files + commit message, so only the
// payload varies between runs.
const baseArgs = (): string[] => [
  "push", "-C", repoDir, "--branch", "main", "--files", "src/x.ts", "-m", "ci: initial", "--json",
];

describe("actwhy --event flag end-to-end", () => {
  it("without --event, the forced-gate is UNKNOWN and names github.event.forced", async () => {
    const { code, stdout } = await runCli(baseArgs());
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Report;

    // the head_commit.message gate is decidable → fires
    expect(job(report, "message-gate").verdict).toBe("fires");

    const forced = job(report, "forced-gate");
    expect(forced.verdict).toBe("unknown");
    expect(forced.reasons[0].code).toBe("if-unknown");
    const text = `${forced.reasons[0].message} ${forced.reasons[0].detail ?? ""}`;
    expect(text).toContain("github.event.forced");
  }, 30_000);

  it("with --event supplying forced:false, the forced-gate FIRES", async () => {
    const { code, stdout } = await runCli([...baseArgs(), "--event", payloadFalse]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Report;
    expect(job(report, "forced-gate").verdict).toBe("fires");
  }, 30_000);

  it("with --event flipping forced:true, the forced-gate is SKIPPED (if-false)", async () => {
    const { code, stdout } = await runCli([...baseArgs(), "--event", payloadTrue]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Report;
    const forced = job(report, "forced-gate");
    expect(forced.verdict).toBe("skipped");
    expect(forced.reasons[0].code).toBe("if-false");
  }, 30_000);

  it("malformed JSON payload → exit 2 with a clear 'invalid JSON' message", async () => {
    const { code, stderr } = await runCli([...baseArgs(), "--event", payloadBad]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/invalid JSON in event file/);
  }, 30_000);

  it("missing payload file → exit 2 with a 'could not read event file' message", async () => {
    const missing = join(workDir, "does-not-exist.json");
    const { code, stderr } = await runCli([...baseArgs(), "--event", missing]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/could not read event file/);
  }, 30_000);
});
