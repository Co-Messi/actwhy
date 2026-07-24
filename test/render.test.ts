/**
 * Human-readable CLI output (the ANSI tree renderer).
 *
 * `renderReport` is a pure string function whose `color` flag fully decides
 * ANSI emission (the CLI owns the NO_COLOR/TTY decision; the renderer just
 * obeys `pc.createColors(opts.color)`). So we can assert BOTH the colored and
 * the plain paths deterministically via a direct import — no TTY/PTY forcing.
 *
 * Reports are produced by running the real engine on tiny fixtures, so the
 * shapes can never drift from `Report`.
 */

import { describe, it, expect } from "vitest";
import { evaluateWorkflows } from "../src/core/index.js";
import type { PrSpec, PushSpec, Report } from "../src/core/types.js";
import { renderReport } from "../src/cli/render.js";

const file = (name: string, content: string) => ({ name, content });
// ESC (U+001B) then '[' begins every ANSI SGR sequence picocolors emits.
const ESC = /\[/;
const STRIP_ANSI = /\[[0-9;]*m/g;

/** Render with color OFF (the assertion default for stable text). */
function plain(report: Report, opts: Partial<Parameters<typeof renderReport>[1]> = {}): string {
  return renderReport(report, { color: false, ...opts });
}

// ── FIRES line + job "runs" + singular/plural summary ─────────────────────

describe("firing output", () => {
  it("prints a FIRES header, a `runs` job line, and a singular `1 job run` summary", async () => {
    const files = [
      file("ci.yml", `on: push\njobs:\n  build: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const out = plain(await evaluateWorkflows(files, spec));

    expect(out).toMatch(/✔ ci\.yml .*FIRES/);
    expect(out).toMatch(/✔ build\s+runs/);
    // footer: exactly "1 job run" (singular), never "1 jobs"
    expect(out).toMatch(/\b1 of 1 workflows fire\b/);
    expect(out).toMatch(/\b1 job run\b/);
    expect(out).not.toMatch(/\b1 jobs\b/);
  });

  it("uses the plural `2 jobs run` when two jobs fire", async () => {
    const files = [
      file(
        "two.yml",
        `on: push\njobs:\n  a: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n  b: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`,
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const out = plain(await evaluateWorkflows(files, spec));
    expect(out).toMatch(/\b2 jobs run\b/);
  });
});

// ── skipped: message (4-space) + detail (6-space) indentation ─────────────

describe("skipped output indentation", () => {
  it("indents the skip reason 4 spaces and its detail 6 spaces", async () => {
    const files = [
      file(
        "paths.yml",
        `on:\n  push:\n    branches: [main]\n    paths: ['src/**']\njobs:\n  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`,
      ),
    ];
    // main push touching only docs → paths-filter-no-match, with a `changed:` detail.
    const spec: PushSpec = { kind: "push", branch: "main", files: ["docs/a.md"] };
    const out = plain(await evaluateWorkflows(files, spec));
    const lines = out.split("\n");

    expect(out).toMatch(/✘ paths\.yml .*skipped/);
    // 4-space message line
    expect(lines.some((l) => /^ {4}paths filter .* matches none of the 1 changed file/.test(l))).toBe(true);
    // 6-space (dim) detail line listing the changed file
    expect(lines.some((l) => /^ {6}changed: docs\/a\.md$/.test(l))).toBe(true);
  });
});

// ── unknown: verdict word + detail line ───────────────────────────────────

describe("unknown output", () => {
  it("labels the workflow `unknown` and prints the `pass --files` detail line", async () => {
    const files = [
      file(
        "u.yml",
        `on:\n  push:\n    branches: [main]\n    paths: ['src/**']\njobs:\n  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`,
      ),
    ];
    // files:null with a paths filter → honest UNKNOWN, not a guess.
    const spec: PushSpec = { kind: "push", branch: "main", files: null };
    const out = plain(await evaluateWorkflows(files, spec));
    const lines = out.split("\n");

    expect(out).toMatch(/\? u\.yml .*unknown/);
    expect(lines.some((l) => /^ {4}this trigger has paths filters/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {6}pass --files/.test(l))).toBe(true);
  });
});

// ── "not for this event" dim path ─────────────────────────────────────────

describe('"not for this event" path', () => {
  it("renders a workflow_dispatch-only workflow as `not for this event` with a manual-dispatch hint", async () => {
    const files = [
      file("wd.yml", `on:\n  workflow_dispatch:\njobs:\n  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const out = plain(await evaluateWorkflows(files, spec));

    expect(out).toMatch(/\? wd\.yml — not for this event/);
    // the friendly detail (not the raw "listens to" message) is shown
    expect(out).toMatch(/manually dispatched/);
  });
});

// ── warnings block ────────────────────────────────────────────────────────

describe("warnings block", () => {
  it("emits a `⚠ warnings` section for the always-true mixed-template footgun", async () => {
    const files = [
      file(
        "fg.yml",
        `on: push\njobs:\n  oops:\n    if: \${{ github.ref }} == 'refs/heads/never'\n    runs-on: ubuntu-latest\n    steps: [{run: echo}]\n`,
      ),
    ];
    const spec: PushSpec = { kind: "push", branch: "main", files: [] };
    const out = plain(await evaluateWorkflows(files, spec));

    expect(out).toMatch(/⚠ warnings/);
    expect(out).toMatch(/fg\.yml: job "oops":/);
    expect(out).toMatch(/ALWAYS truthy/);
  });
});

// ── NOTHING-fires banner + closest miss ───────────────────────────────────

describe("nothing-fires banner", () => {
  it("prints the NOTHING banner and a closest-miss line pointing at the branch filter", async () => {
    const files = [
      file("only.yml", `on:\n  push:\n    branches: [main]\njobs:\n  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`),
    ];
    // push to a non-matching branch → nothing fires.
    const spec: PushSpec = { kind: "push", branch: "feat", files: [] };
    const out = plain(await evaluateWorkflows(files, spec));

    expect(out).toMatch(/⚠ NOTHING fires for this push\./);
    expect(out).toMatch(/closest miss:.*only\.yml.*does not match "feat"/);
  });

  it('says "pull request" in the banner for a PR event', async () => {
    const files = [
      file("only.yml", `on:\n  pull_request:\n    branches: [main]\njobs:\n  j: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`),
    ];
    const spec: PrSpec = { kind: "pull_request", base: "release", head: "x", files: [] };
    const out = plain(await evaluateWorkflows(files, spec));
    expect(out).toMatch(/⚠ NOTHING fires for this pull request\./);
  });
});

// ── color vs no-color (ANSI emission is governed solely by `color`) ────────

describe("color control", () => {
  it("emits ANSI escapes when color:true and none when color:false", async () => {
    const files = [
      file("ci.yml", `on: push\njobs:\n  build: {runs-on: ubuntu-latest, steps: [{run: echo}]}\n`),
    ];
    const report = await evaluateWorkflows(files, { kind: "push", branch: "main", files: [] });

    const colored = renderReport(report, { color: true });
    const mono = renderReport(report, { color: false });

    expect(ESC.test(colored)).toBe(true);
    expect(ESC.test(mono)).toBe(false);
    // stripping the escapes from the colored output yields exactly the plain output
    expect(colored.replace(STRIP_ANSI, "")).toBe(mono);
  });
});
