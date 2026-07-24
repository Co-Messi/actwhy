import { describe, expect, it } from "vitest";
import { buildSpec } from "../web/src/engine.js";
import type { AppState } from "../web/src/engine.js";

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
