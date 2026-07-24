import { describe, it, expect } from "vitest";
import { evaluateIf, buildRootContext } from "../src/core/index.js";
import type { RootContext } from "../src/core/context.js";

// The canonical simulated context: a push to `main` on me/repo whose head
// commit message is known and contains "[skip ci]".
const ctx: RootContext = buildRootContext({
  kind: "push",
  branch: "main",
  files: ["src/a.ts"],
  repository: "me/repo",
  commitMessage: "hello [skip ci]",
});

// Happy-path status assumptions used for most cases.
const OK = { success: true, failure: false, cancelled: false };

describe("equality & context reads", () => {
  it("github.ref matches the simulated branch ref", () => {
    expect(evaluateIf("github.ref == 'refs/heads/main'", ctx, OK).truthiness).toBe(
      true,
    );
  });

  it("a wrong branch comparison is false", () => {
    expect(
      evaluateIf("github.ref == 'refs/heads/other'", ctx, OK).truthiness,
    ).toBe(false);
  });

  it("string equality is case-insensitive (OrdinalIgnoreCase)", () => {
    expect(evaluateIf("github.ref_name == 'MAIN'", ctx, OK).truthiness).toBe(true);
  });

  it("records the known context values it read (for explanations)", () => {
    const out = evaluateIf("github.ref == 'refs/heads/x'", ctx, OK);
    expect(out.reads.has("github.ref")).toBe(true);
    expect(out.reads.get("github.ref")).toBe("refs/heads/main");
  });
});

describe("loose coercion (GitHub's own rules)", () => {
  it("compares a numeric string to a number loosely: '3' == 3", () => {
    expect(evaluateIf("'3' == 3", ctx, OK).truthiness).toBe(true);
  });

  it("coerces both sides of '' == null to equal", () => {
    // GitHub coerces null and '' toward each other — verified against the
    // @actions/expressions library, both orders hold.
    expect(evaluateIf("'' == null", ctx, OK).truthiness).toBe(true);
    expect(evaluateIf("null == ''", ctx, OK).truthiness).toBe(true);
  });
});

describe("Kleene / three-valued logic over runtime-only context", () => {
  // `vars` is an opaque Unk in the static context, so `vars.MISSING` is unknown.
  it("unknown && false is decidably false", () => {
    expect(evaluateIf("vars.MISSING && false", ctx, OK).truthiness).toBe(false);
  });

  it("unknown || true is decidably true", () => {
    expect(evaluateIf("vars.MISSING || true", ctx, OK).truthiness).toBe(true);
  });

  it("unknown && true stays unknown and reports the responsible path", () => {
    const out = evaluateIf("vars.MISSING && true", ctx, OK);
    expect(out.truthiness).toBe("unknown");
    expect(out.deps.map((d) => d.path)).toContain("vars.MISSING");
  });

  it("negating an unknown stays unknown", () => {
    expect(evaluateIf("!vars.MISSING", ctx, OK).truthiness).toBe("unknown");
  });
});

describe("string functions", () => {
  it("contains() over a known head-commit message is case-insensitive", () => {
    expect(
      evaluateIf(
        "contains(github.event.head_commit.message, '[SKIP CI]')",
        ctx,
        OK,
      ).truthiness,
    ).toBe(true);
  });

  it("startsWith() over github.ref", () => {
    expect(
      evaluateIf("startsWith(github.ref, 'refs/heads/')", ctx, OK).truthiness,
    ).toBe(true);
  });

  it("format() + join() round-trip to known strings", () => {
    expect(
      evaluateIf("format('{0}/{1}', 'a', 'b') == 'a/b'", ctx, OK).truthiness,
    ).toBe(true);
    expect(
      evaluateIf(
        "join(fromJSON('[\"a\",\"b\"]'), '-') == 'a-b'",
        ctx,
        OK,
      ).truthiness,
    ).toBe(true);
  });

  it("fromJSON('true') is truthy", () => {
    expect(evaluateIf("fromJSON('true')", ctx, OK).truthiness).toBe(true);
  });

  it("projects filtered arrays such as pull-request label names", () => {
    const pr = buildRootContext({
      kind: "pull_request",
      base: "main",
      files: ["src/a.ts"],
      payload: {
        pull_request: {
          labels: [{ name: "bug" }, { name: "urgent" }],
        },
      },
    });
    const out = evaluateIf(
      "contains(github.event.pull_request.labels.*.name, 'bug')",
      pr,
      OK,
    );
    expect(out.error).toBeUndefined();
    expect(out.truthiness).toBe(true);
  });
});

describe("status functions", () => {
  it("always() is true even when success is false", () => {
    const out = evaluateIf("always()", ctx, {
      success: false,
      failure: false,
      cancelled: false,
    });
    expect(out.truthiness).toBe(true);
    expect(out.statusFnsUsed.has("always")).toBe(true);
  });

  it("failure() is false under the happy-path assumption and is tracked", () => {
    const out = evaluateIf("failure()", ctx, OK);
    expect(out.truthiness).toBe(false);
    expect(out.statusFnsUsed.has("failure")).toBe(true);
  });

  it("success() reflects the assumed success status", () => {
    expect(
      evaluateIf("success()", ctx, {
        success: false,
        failure: false,
        cancelled: false,
      }).truthiness,
    ).toBe(false);
  });
});

describe("honest unknowns", () => {
  it("hashFiles() is unknown (computed on the runner)", () => {
    const out = evaluateIf("hashFiles('**/lockfile')", ctx, OK);
    expect(out.truthiness).toBe("unknown");
    expect(out.deps.length).toBeGreaterThan(0);
  });

  it("a payload key absent on a push event is unknown (partial payload)", () => {
    const out = evaluateIf("github.event.pull_request", ctx, OK);
    expect(out.truthiness).toBe("unknown");
    expect(out.deps.map((d) => d.path)).toContain("github.event.pull_request");
  });

  it("an unknown TOP-LEVEL github key resolves to null (complete dict)", () => {
    // github is modeled as a complete dictionary, so a missing key is null,
    // not unknown — `== null` is decidably true.
    expect(
      evaluateIf("github.nonexistent_key == null", ctx, OK).truthiness,
    ).toBe(true);
    // and null coerces to '' as well
    expect(evaluateIf("github.nonexistent_key == ''", ctx, OK).truthiness).toBe(
      true,
    );
  });
});

describe("operator precedence", () => {
  it("&& binds tighter than ||: false || true && false is false", () => {
    expect(evaluateIf("false || true && false", ctx, OK).truthiness).toBe(false);
  });
});
