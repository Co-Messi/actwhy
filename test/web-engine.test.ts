import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateWorkflows } from "../src/core/index.js";
import { buildSpec } from "../web/src/engine.js";
import type { AppState } from "../web/src/engine.js";
import { resolutionActions } from "../web/src/actions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const state = (overrides: Partial<AppState> = {}): AppState => ({
  files: [{ name: "ci.yml", content: "on: push\njobs: {}" }],
  active: 0,
  event: "push",
  branch: "main",
  tag: "v1.0.0",
  changed: "src/a.ts",
  commitMessage: "test: update [skip ci]",
  prBase: "main",
  prHead: "feature/test",
  prActivity: "opened",
  ...overrides,
});

describe("web buildSpec", () => {
  it("passes the commit message into pull request simulations", () => {
    const spec = buildSpec(state({ event: "pull_request" }));
    expect(spec.kind).toBe("pull_request");
    if (spec.kind === "pull_request") {
      expect(spec.commitMessage).toBe("test: update [skip ci]");
    }
  });
});

describe("website onboarding and privacy contract", () => {
  const html = readFileSync(join(root, "web", "index.html"), "utf8");

  it("makes the live playground the primary hero action", () => {
    expect(html).toContain('class="hero-primary" href="#playground"');
    expect(html).toContain("Try the live playground");
  });

  it("prompts visitors to replace the example with their own workflow", () => {
    expect(html).toContain("Replace this example with your workflow");
    expect(html).toContain('id="focus-editor"');
  });

  it("warns that shared URLs contain scenario data and can be retained", () => {
    expect(html).toContain("workflow YAML");
    expect(html).toContain("browser history");
    expect(html).toContain("chat");
  });

  it("includes a mobile updated-verdict control and reduced-motion fallback", () => {
    expect(html).toContain('id="mobile-verdict"');
    expect(html).toContain("View updated verdict");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("contextual resolution actions", () => {
  it("offers a branch retest and reason copy for a branch-filter miss", async () => {
    const report = await evaluateWorkflows(
      [
        {
          name: "ci.yml",
          content: "on:\n  push:\n    branches: [main]\njobs:\n  j: {runs-on: ubuntu-latest}\n",
        },
      ],
      { kind: "push", branch: "feature/x", files: ["src/a.ts"] },
    );
    const actions = resolutionActions(report);
    expect(actions.map((a) => a.id)).toEqual([
      "test-branch",
      "switch-pr",
      "copy-reason",
      "share",
    ]);
  });

  it("offers changed-path input for a path-filter miss", async () => {
    const report = await evaluateWorkflows(
      [
        {
          name: "ci.yml",
          content: "on:\n  push:\n    paths: ['src/**']\njobs:\n  j: {runs-on: ubuntu-latest}\n",
        },
      ],
      { kind: "push", branch: "main", files: ["docs/readme.md"] },
    );
    expect(resolutionActions(report).map((a) => a.id)).toContain("add-path");
  });
});
