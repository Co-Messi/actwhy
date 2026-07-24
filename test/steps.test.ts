/**
 * Step-level `if:` evaluation, enabled via `evaluateWorkflows(files, spec,
 * { steps: true })`.
 *
 * Steps are only walked when their JOB fires (evaluate.ts gates step
 * evaluation on `verdictInfo.verdict === "fires"`), so each case asserts the
 * enclosing job fires first — otherwise a regression that skips the job would
 * silently empty `steps` and let these assertions pass vacuously.
 */

import { describe, it, expect } from "vitest";
import { evaluateWorkflows } from "../src/core/index.js";
import type { PushSpec, StepVerdict, WorkflowVerdict } from "../src/core/types.js";

const file = (name: string, content: string) => ({ name, content });
const codes = (rs: { code: string }[]): string[] => rs.map((r) => r.code);

// A firing job (bare success()) whose steps exercise every decision path.
const STEPS_YAML = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo default
      - name: always step
        if: always()
        run: echo always
      - name: failure step
        if: failure()
        run: echo fail
      - name: push-only step
        if: github.event_name == 'push'
        run: echo pushonly
      - name: matrix step
        if: matrix.os == 'ubuntu-latest'
        run: echo matrix
`;

describe("step-level `if:` evaluation (options.steps)", () => {
  const spec: PushSpec = { kind: "push", branch: "main", files: null };

  async function buildJobSteps(): Promise<{ w: WorkflowVerdict; steps: StepVerdict[] }> {
    const report = await evaluateWorkflows([file("s.yml", STEPS_YAML)], spec, { steps: true });
    const w = report.workflows.find((x) => x.file === "s.yml")!;
    const build = w.jobs.find((j) => j.id === "build")!;
    // Precondition: steps are only present when the job fires.
    expect(build.verdict).toBe("fires");
    expect(build.steps).toBeDefined();
    return { w, steps: build.steps! };
  }

  const byName = (steps: StepVerdict[], name: string): StepVerdict =>
    steps.find((s) => s.name === name)!;

  it("the default (no-if) step fires and an anonymous run step is labeled 'step N'", async () => {
    const { steps } = await buildJobSteps();
    // The first step has no name and a synthesized id → labeled by position.
    expect(steps[0].name).toBe("step 1");
    expect(steps[0].verdict).toBe("fires");
  });

  it("a step `if: always()` under a firing job fires", async () => {
    const { steps } = await buildJobSteps();
    expect(byName(steps, "always step").verdict).toBe("fires");
  });

  it("a step `if: failure()` is skipped, gated on a prior failure", async () => {
    const { steps } = await buildJobSteps();
    const s = byName(steps, "failure step");
    expect(s.verdict).toBe("skipped");
    expect(codes(s.reasons)).toContain("failure-gated");
  });

  it("a step `if: github.event_name == 'push'` is decidable and fires on a push", async () => {
    const { steps } = await buildJobSteps();
    expect(byName(steps, "push-only step").verdict).toBe("fires");
  });

  it("a step referencing matrix.* is unknown (matrix values only exist at runtime)", async () => {
    const { steps } = await buildJobSteps();
    const s = byName(steps, "matrix step");
    expect(s.verdict).toBe("unknown");
    expect(codes(s.reasons)).toContain("if-unknown");
    expect(s.reasons[0].message).toMatch(/matrix/);
  });

  it("does not populate steps when options.steps is omitted", async () => {
    const report = await evaluateWorkflows([file("s.yml", STEPS_YAML)], spec);
    const build = report.workflows[0].jobs.find((j) => j.id === "build")!;
    expect(build.verdict).toBe("fires");
    expect(build.steps).toBeUndefined();
  });
});
