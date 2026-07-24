import { describe, it, expect } from "vitest";
import {
  compilePattern,
  matchPatternList,
  anyFileMatches,
  allFilesIgnored,
} from "../src/core/patterns.js";

/** Compile a GitHub filter pattern and test a value against it. */
const matches = (pattern: string, value: string): boolean =>
  compilePattern(pattern).test(value);

describe("compilePattern — `*` (zero+ chars, but not `/`)", () => {
  it("`feature/*` matches one segment but not a nested one", () => {
    expect(matches("feature/*", "feature/a")).toBe(true);
    expect(matches("feature/*", "feature/a/b")).toBe(false);
    // zero characters are allowed
    expect(matches("feature/*", "feature/")).toBe(true);
  });

  it("bare `*` matches a single segment, not a slashed path", () => {
    expect(matches("*", "main")).toBe(true);
    expect(matches("*", "a/b")).toBe(false);
  });
});

describe("compilePattern — `**` (crosses `/`)", () => {
  it("`releases/**` matches nested paths", () => {
    expect(matches("releases/**", "releases/a/b")).toBe(true);
    expect(matches("releases/**", "releases/a")).toBe(true);
    // `**` matches zero characters too, so the bare prefix matches
    expect(matches("releases/**", "releases/")).toBe(true);
  });

  it("bare `**` matches anything", () => {
    expect(matches("**", "a/b/c")).toBe(true);
    expect(matches("**", "main")).toBe(true);
    expect(matches("**", "")).toBe(true);
  });

  it("a slash-delimited globstar matches zero or more directories", () => {
    expect(matches("docs/**/*.md", "docs/README.md")).toBe(true);
    expect(matches("docs/**/*.md", "docs/guides/start.md")).toBe(true);
    expect(matches("a/**/b", "a/b")).toBe(true);
    expect(matches("a/**/b", "a/x/y/b")).toBe(true);
    expect(matches("a/**/b", "a/xb")).toBe(false);
  });

  it("does not absorb the slash after a non-delimited globstar", () => {
    expect(matches("foo**/bar", "foobar")).toBe(false);
    expect(matches("foo**/bar", "foo/bar")).toBe(true);
    expect(matches("foo**/bar", "foo/x/bar")).toBe(true);
  });
});

describe("compilePattern — `?` is ZERO OR ONE of the preceding char (regex-style)", () => {
  it("`ab?` matches `a` and `ab`, but not `abb`", () => {
    expect(matches("ab?", "a")).toBe(true);
    expect(matches("ab?", "ab")).toBe(true);
    expect(matches("ab?", "abb")).toBe(false);
  });

  it("`JavaScript?` matches `JavaScrip` and `JavaScript`, not a doubled `t`", () => {
    expect(matches("JavaScript?", "JavaScrip")).toBe(true);
    expect(matches("JavaScript?", "JavaScript")).toBe(true);
    expect(matches("JavaScript?", "JavaScriptt")).toBe(false);
  });
});

describe("compilePattern — `+` is ONE OR MORE of the preceding char", () => {
  it("`ab+` matches `ab` and `abb`, but not `a`", () => {
    expect(matches("ab+", "ab")).toBe(true);
    expect(matches("ab+", "abb")).toBe(true);
    expect(matches("ab+", "a")).toBe(false);
  });
});

describe("compilePattern — character classes combined with quantifiers", () => {
  it("`v[12].[0-9]+` matches `v1.10` and `v2.0` but not `v3.0` or `v1.x`", () => {
    expect(matches("v[12].[0-9]+", "v1.10")).toBe(true);
    expect(matches("v[12].[0-9]+", "v2.0")).toBe(true);
    expect(matches("v[12].[0-9]+", "v3.0")).toBe(false);
    expect(matches("v[12].[0-9]+", "v1.x")).toBe(false);
  });
});

describe("compilePattern — escaping with `\\`", () => {
  it("`a\\*b` matches the literal `a*b` only", () => {
    // In YAML source this pattern is written `a\*b`.
    expect(matches("a\\*b", "a*b")).toBe(true);
    expect(matches("a\\*b", "axb")).toBe(false);
    expect(matches("a\\*b", "ab")).toBe(false);
  });
});

describe("compilePattern — matching is case-sensitive", () => {
  it("`Main` does not match `main`", () => {
    expect(matches("Main", "main")).toBe(false);
    expect(matches("Main", "Main")).toBe(true);
  });
});

describe("compilePattern — the CompiledPattern shape and error cases", () => {
  it("strips a leading `!` into the `negative` flag and keeps the bare source", () => {
    const cp = compilePattern("!docs/**");
    expect(cp.negative).toBe(true);
    expect(cp.source).toBe("docs/**");
  });

  it("a positive pattern reports negative=false", () => {
    expect(compilePattern("src/**").negative).toBe(false);
  });

  it("throws on an unterminated character class", () => {
    expect(() => compilePattern("a[")).toThrow(/Unterminated character class/);
  });

  it("throws on a trailing backslash", () => {
    expect(() => compilePattern("a\\")).toThrow(/Trailing backslash/);
  });
});

describe("matchPatternList — GitHub negation ordering", () => {
  it("a trailing negative pattern excludes an earlier positive match", () => {
    expect(matchPatternList(["**", "!docs/**"], "docs/a.md").matched).toBe(false);
    expect(matchPatternList(["**", "!docs/**"], "src/a.ts").matched).toBe(true);
  });

  it("a later positive pattern re-includes after a negative exclusion", () => {
    expect(
      matchPatternList(["**", "!docs/**", "docs/keep.md"], "docs/keep.md").matched,
    ).toBe(true);
    // a sibling under docs/ that isn't re-included stays excluded
    expect(
      matchPatternList(["**", "!docs/**", "docs/keep.md"], "docs/other.md").matched,
    ).toBe(false);
  });

  it("reports the pattern that made the final decision", () => {
    const m = matchPatternList(["**", "!docs/**"], "docs/a.md");
    expect(m.decidedBy?.negative).toBe(true);
    expect(m.decidedBy?.source).toBe("docs/**");
  });

  it("flags startsNegative when the list opens with a negative pattern", () => {
    expect(matchPatternList(["!a"], "a").startsNegative).toBe(true);
    expect(matchPatternList(["**", "!docs/**"], "x").startsNegative).toBe(false);
  });

  it("a lone negative pattern never nets a positive match", () => {
    // `!a` alone: `a` is matched by the negative → net excluded.
    expect(matchPatternList(["!a"], "a").matched).toBe(false);
    // a value the negative doesn't touch also stays unmatched (nothing includes it)
    expect(matchPatternList(["!a"], "b").matched).toBe(false);
  });
});

describe("anyFileMatches — fires when any file is net-included", () => {
  it("returns the first matching file", () => {
    const m = anyFileMatches(["src/**"], ["README.md", "src/a.ts"]);
    expect(m.matched).toBe(true);
    expect(m.matchingFile).toBe("src/a.ts");
  });

  it("is false when no file matches", () => {
    expect(anyFileMatches(["src/**"], ["README.md"]).matched).toBe(false);
  });

  it("is false for an empty file list", () => {
    expect(anyFileMatches(["src/**"], []).matched).toBe(false);
  });

  it("honors negation (a vendored file under an excluded subtree does not match)", () => {
    const m = anyFileMatches(
      ["src/**", "!src/vendor/**"],
      ["src/vendor/lib.js"],
    );
    expect(m.matched).toBe(false);
  });
});

describe("allFilesIgnored — skip only when every file is ignored", () => {
  it("is true when all files match the ignore list", () => {
    const r = allFilesIgnored(["docs/**", "*.md"], ["docs/a.md", "README.md"]);
    expect(r.allIgnored).toBe(true);
  });

  it("returns the first escaping file when one is not ignored", () => {
    const r = allFilesIgnored(["docs/**"], ["docs/a.md", "src/x.ts"]);
    expect(r.allIgnored).toBe(false);
    expect(r.escapingFile).toBe("src/x.ts");
  });

  it("is vacuously true for an empty file list", () => {
    expect(allFilesIgnored(["docs/**"], []).allIgnored).toBe(true);
  });
});
