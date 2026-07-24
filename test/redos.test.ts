/**
 * Regression lock for the CRITICAL fix: the filter-pattern compiler now runs a
 * linear-time Thompson NFA (see src/core/patterns.ts) instead of a backtracking
 * RegExp. Patterns come from untrusted repos, so a hostile filter must be
 * impossible to weaponize into catastrophic backtracking BY CONSTRUCTION.
 *
 * This file asserts two independent things:
 *   1. CORRECTNESS — the NFA is language-equivalent to GitHub's documented
 *      `?`/`+`/`*`/`**`/`[]` semantics, including the tricky *second* quantifier
 *      cases (`a++`, `a?+`, `a+?`) that a naive RegExp translation mishandles.
 *   2. SPEED — the adversarial inputs that hung the OLD implementation for
 *      minutes now complete in well under a fixed ceiling. A regression to a
 *      backtracking engine would blow the timing assertion (or hang the worker),
 *      which is exactly the failure this test exists to catch.
 *
 * `.test` is a METHOD on the compiled pattern now (it used to be a `.regex`
 * RegExp) — using it here also pins that API shape.
 */

import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { compilePattern, matchPatternList } from "../src/core/patterns.js";

const matches = (pattern: string, value: string): boolean =>
  compilePattern(pattern).test(value);

// ── 1a. Second-quantifier correctness (language-equivalence) ───────────────
//
// GitHub's `?`/`+` are regex-style quantifiers on the PRECEDING atom. A second
// quantifier stacked on an atom must collapse to the equivalent single one:
//   a++ ≡ a+ ,  a?+ ≡ a* ,  a+? ≡ a*  (and *?/**?/*+ ≡ */**).

describe("NFA correctness — stacked quantifiers collapse to the right language", () => {
  it("`a++` (≡ a+) matches one-or-more `a`, not empty, not a trailing other char", () => {
    expect(matches("a++", "a")).toBe(true);
    expect(matches("a++", "aaa")).toBe(true);
    expect(matches("a++", "")).toBe(false);
    expect(matches("a++", "a!")).toBe(false);
  });

  it("`a?+` (≡ a*) matches empty and any run of `a`, but not a different char", () => {
    expect(matches("a?+", "")).toBe(true);
    expect(matches("a?+", "a")).toBe(true);
    expect(matches("a?+", "aaa")).toBe(true);
    expect(matches("a?+", "b")).toBe(false);
  });

  it("`a+?` (≡ a*) behaves identically to `a?+`", () => {
    expect(matches("a+?", "")).toBe(true);
    expect(matches("a+?", "a")).toBe(true);
    expect(matches("a+?", "aaa")).toBe(true);
    expect(matches("a+?", "b")).toBe(false);
  });

  it("`[a-z]++` matches one-or-more lowercase letters, not a digit", () => {
    expect(matches("[a-z]++", "abc")).toBe(true);
    expect(matches("[a-z]++", "a")).toBe(true);
    expect(matches("[a-z]++", "9")).toBe(false);
    expect(matches("[a-z]++", "")).toBe(false);
  });

  it("`ab++` (≡ a b+) requires an `a` then one-or-more `b`", () => {
    expect(matches("ab++", "ab")).toBe(true);
    expect(matches("ab++", "abbb")).toBe(true);
    expect(matches("ab++", "a")).toBe(false);
    expect(matches("ab++", "b")).toBe(false);
  });

  it("previously-safe star combos still behave like `*` / `**`", () => {
    // `*+` ≡ `*`: zero+ non-slash chars.
    expect(matches("*+", "a")).toBe(true);
    expect(matches("*+", "")).toBe(true);
    expect(matches("*+", "a/b")).toBe(false);
    // `**?` ≡ `**`: zero+ of ANY char (crosses `/`).
    expect(matches("**?", "a/b")).toBe(true);
    expect(matches("**?", "")).toBe(true);
    // `*?` ≡ `*`: single segment, not a slashed path.
    expect(matches("*?", "a")).toBe(true);
    expect(matches("*?", "")).toBe(true);
    expect(matches("*?", "a/b")).toBe(false);
  });
});

// ── 1b. Live-GitHub-semantics anchors (NFA rewrite stays faithful) ─────────

describe("NFA correctness — golden GitHub filter semantics", () => {
  it("`feature/*` matches one segment but not a nested path", () => {
    expect(matches("feature/*", "feature/a")).toBe(true);
    expect(matches("feature/*", "feature/a/b")).toBe(false);
  });

  it("`releases/**` matches nested paths (crosses `/`)", () => {
    expect(matches("releases/**", "releases/a/b")).toBe(true);
    expect(matches("releases/**", "releases/a")).toBe(true);
  });

  it("`v[12].[0-9]+` matches `v1.10`, not `v3.0`", () => {
    expect(matches("v[12].[0-9]+", "v1.10")).toBe(true);
    expect(matches("v[12].[0-9]+", "v3.0")).toBe(false);
  });

  it("`ab?` (≡ a b?) matches `a`, not `abb`", () => {
    expect(matches("ab?", "a")).toBe(true);
    expect(matches("ab?", "ab")).toBe(true);
    expect(matches("ab?", "abb")).toBe(false);
  });

  it("negation ordering: a later positive re-includes one file but not its sibling", () => {
    const list = ["**", "!docs/**", "docs/keep.md"];
    expect(matchPatternList(list, "docs/keep.md").matched).toBe(true);
    expect(matchPatternList(list, "docs/x.md").matched).toBe(false);
  });
});

// ── 2. Anti-ReDoS timing ───────────────────────────────────────────────────
//
// Each pattern is paired with adversarial inputs drawn from ITS OWN alphabet —
// a long run over the characters the pattern repeats, arranged to force a
// near-miss. `x+x+…y` fed all-`a` would bail at char 1 and prove nothing; its
// killer input is a long run of `x` with NO trailing `y`. The linear NFA
// dispatches every one of these in microseconds; the old backtracking RegExp
// hung for minutes.

const A = (n: number): string => "a".repeat(n);
const N = 50_000;
// Real impl is ~microseconds; 500ms is orders of magnitude of headroom while
// still failing hard if a backtracking engine ever returns.
const THRESHOLD_MS = 500;

const timingCases: { pattern: string; inputs: string[] }[] = [
  { pattern: "a++", inputs: [A(N), A(N) + "!"] },
  { pattern: "a?+", inputs: [A(N), A(N) + "b"] },
  { pattern: "[a-z]++", inputs: [A(N), A(N) + "9"] },
  { pattern: "ab++", inputs: ["a" + "b".repeat(N), "b".repeat(N)] },
  { pattern: "*a*a*a*a*a*a*a*a", inputs: [A(N), "b".repeat(N)] },
  // Classic evil-regex shape: a long run of `x` with no closing `y` is the
  // catastrophic near-miss; the trailing-`z` variant is a second non-match.
  { pattern: "x+x+x+x+x+x+x+x+y", inputs: ["x".repeat(N), "x".repeat(N) + "z"] },
];

describe("anti-ReDoS — hostile filters resolve in linear time, not minutes", () => {
  it(
    "every adversarial (pattern, 50k-char input) pair completes well under the ceiling",
    () => {
      for (const { pattern, inputs } of timingCases) {
        const cp = compilePattern(pattern);
        for (const input of inputs) {
          const t0 = performance.now();
          cp.test(input);
          const ms = performance.now() - t0;
          expect(
            ms,
            `compilePattern(${JSON.stringify(pattern)}).test(<${input.length} chars>) took ${ms.toFixed(2)}ms`,
          ).toBeLessThan(THRESHOLD_MS);
        }
      }
    },
    15_000,
  );
});
