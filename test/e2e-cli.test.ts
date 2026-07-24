import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "../src/core/types.js";

// Project root (this file lives in <root>/test/).
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "dist", "actwhy.js");

// A fixture workflow: fires on push to main touching src/**.
const FIXTURE_YAML = `name: CLI Fixture
on:
  push:
    branches: [main]
    paths: ['src/**']
  pull_request:
    branches: [main]
    paths: ['src/**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{run: echo build}]
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI and resolve with its exit code + captured output. */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: projectRoot },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

let fixtureDir: string;

beforeAll(() => {
  // Build the standalone CLI (as the task requires) before exercising it.
  execFileSync("npm", ["run", "build"], {
    cwd: projectRoot,
    stdio: "ignore",
    timeout: 120_000,
  });

  // Create a temp fixture git repo (never inside the project).
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "actwhy-e2e-")));
  mkdirSync(join(fixtureDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(fixtureDir, ".github", "workflows", "ci.yml"),
    FIXTURE_YAML,
  );
  // Best-effort `git init` so the fixture is a real repo; the CLI degrades
  // gracefully without it, and we pass --branch/--files explicitly anyway.
  try {
    execFileSync("git", ["init", "-q"], { cwd: fixtureDir, stdio: "ignore" });
  } catch {
    /* git unavailable — the CLI still works via explicit flags */
  }
}, 120_000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("actwhy CLI end-to-end", () => {
  it("`push --json` exits 0 and emits a well-formed Report", async () => {
    const { code, stdout } = await runCli([
      "push",
      "-C",
      fixtureDir,
      "--branch",
      "main",
      "--files",
      "src/a.ts",
      "--json",
    ]);
    expect(code).toBe(0);

    const report = JSON.parse(stdout) as Report;
    expect(report.event.kind).toBe("push");
    expect(Array.isArray(report.workflows)).toBe(true);
    expect(report.workflows[0].file).toBe("ci.yml");
    expect(report.workflows[0].verdict).toBe("fires");
    expect(report.summary.workflowsTotal).toBe(1);
    expect(report.summary.workflowsFiring).toBe(1);
    expect(report.nothingFires).toBe(false);
    expect(typeof report.summary.matrixVariantsFiring).toBe("number");
  }, 30_000);

  it("`push` to a non-matching branch reports nothingFires with a closestMiss", async () => {
    const { code, stdout } = await runCli([
      "push",
      "-C",
      fixtureDir,
      "--branch",
      "feat",
      "--files",
      "src/a.ts",
      "--json",
    ]);
    expect(code).toBe(0);

    const report = JSON.parse(stdout) as Report;
    expect(report.workflows[0].verdict).toBe("skipped");
    expect(report.workflows[0].reasons[0].code).toBe("branch-filter-no-match");
    expect(report.nothingFires).toBe(true);
    expect(report.closestMiss?.file).toBe("ci.yml");
  }, 30_000);

  it("`pr -m` simulates a pull-request commit skip directive", async () => {
    const { code, stdout } = await runCli([
      "pr",
      "-C",
      fixtureDir,
      "--base",
      "main",
      "--files",
      "src/a.ts",
      "-m",
      "test: update [skip ci]",
      "--json",
    ]);
    expect(code).toBe(0);

    const report = JSON.parse(stdout) as Report;
    expect(report.workflows[0].verdict).toBe("skipped");
    expect(report.workflows[0].reasons[0].code).toBe("commit-message-skip");
  }, 30_000);

  it("an unknown flag exits 2 (usage error) with a help pointer on stderr", async () => {
    const { code, stderr } = await runCli(["--nope"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/actwhy:/);
    expect(stderr.toLowerCase()).toContain("help");
  }, 30_000);

  it("an unknown subcommand also exits 2", async () => {
    const { code } = await runCli(["bogus"]);
    expect(code).toBe(2);
  }, 30_000);

  it("`--version` exits 0 and prints a version string", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it("`--help` exits 0 and prints usage", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("USAGE");
  }, 30_000);
});
