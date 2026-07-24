/**
 * GitHub Actions filter-pattern engine.
 *
 * GitHub's `branches` / `tags` / `paths` filters do NOT use standard globs.
 * Per the official "Filter pattern cheat sheet":
 *
 *   *    matches zero or more characters, but not `/`
 *   **   matches zero or more of any character
 *   ?    matches ZERO OR ONE of the PRECEDING character (regex-style!)
 *   +    matches ONE OR MORE of the PRECEDING character (regex-style!)
 *   []   matches one character listed or in a range
 *   !    at the start of a pattern negates previous positive patterns
 *   \    escapes the following special character
 *
 * The `?`/`+` quantifier semantics are the part most third-party glob
 * libraries get wrong. Matching is case-sensitive and anchored.
 */

export interface CompiledPattern {
  /** Original pattern text (without a leading `!`). */
  source: string;
  negative: boolean;
  regex: RegExp;
}

const REGEX_SPECIALS = new Set([
  ".", "^", "$", "|", "(", ")", "{", "}", "\\",
  "*", "+", "?", "[", "]",
]);

function escapeChar(c: string): string {
  return REGEX_SPECIALS.has(c) ? `\\${c}` : c;
}

/**
 * Compile one GitHub filter pattern into an anchored RegExp.
 * Throws on malformed patterns (unterminated `[` class, trailing `\`).
 */
export function compilePattern(pattern: string): CompiledPattern {
  let negative = false;
  let p = pattern;
  if (p.startsWith("!")) {
    negative = true;
    p = p.slice(1);
  }

  let out = "";
  /** Regex text of the last emitted atom, so `?` / `+` can wrap it. */
  let lastAtom: string | null = null;

  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      let stars = 0;
      while (p[i] === "*") {
        stars++;
        i++;
      }
      if (lastAtom !== null) out += lastAtom;
      lastAtom = stars >= 2 ? ".*" : "[^/]*";
      continue;
    }
    if (c === "?" || c === "+") {
      if (lastAtom === null) {
        // No preceding atom — GitHub treats this as a literal character.
        lastAtom = escapeChar(c);
      } else {
        lastAtom = `(?:${lastAtom})${c === "?" ? "?" : "+"}`;
      }
      i++;
      continue;
    }
    if (c === "[") {
      const close = p.indexOf("]", i + 1);
      if (close === -1) {
        throw new Error(`Unterminated character class in pattern "${pattern}"`);
      }
      const body = p.slice(i + 1, close);
      // Escape regex-significant chars inside the class, preserving `-` ranges.
      const safe = body.replace(/[\\^\]]/g, (m) => `\\${m}`);
      if (lastAtom !== null) out += lastAtom;
      lastAtom = `[${safe}]`;
      i = close + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= p.length) {
        throw new Error(`Trailing backslash in pattern "${pattern}"`);
      }
      if (lastAtom !== null) out += lastAtom;
      lastAtom = escapeChar(p[i + 1]);
      i += 2;
      continue;
    }
    if (lastAtom !== null) out += lastAtom;
    lastAtom = escapeChar(c);
    i++;
  }
  if (lastAtom !== null) out += lastAtom;

  return { source: p, negative, regex: new RegExp(`^${out}$`) };
}

export interface PatternListMatch {
  matched: boolean;
  /** The pattern that made the final include/exclude decision, if any. */
  decidedBy?: CompiledPattern;
  /** True if the list starts with a negative pattern (GitHub footgun). */
  startsNegative: boolean;
}

/**
 * Match a value against an ordered pattern list with GitHub's negation
 * semantics: order matters — a matching negative pattern after a positive
 * match excludes again; a matching positive pattern after a negative match
 * re-includes.
 */
export function matchPatternList(patterns: readonly string[], value: string): PatternListMatch {
  let matched = false;
  let decidedBy: CompiledPattern | undefined;
  const compiled = patterns.map(compilePattern);
  const startsNegative = compiled.length > 0 && compiled[0].negative;
  for (const cp of compiled) {
    if (cp.regex.test(value)) {
      matched = !cp.negative;
      decidedBy = cp;
    }
  }
  return { matched, decidedBy, startsNegative };
}

/**
 * Evaluate a `paths:`-style list against a set of changed files.
 * The workflow fires if at least one file is net-included by the list.
 */
export function anyFileMatches(patterns: readonly string[], files: readonly string[]): {
  matched: boolean;
  matchingFile?: string;
  decidedBy?: CompiledPattern;
} {
  for (const f of files) {
    const m = matchPatternList(patterns, f);
    if (m.matched) return { matched: true, matchingFile: f, decidedBy: m.decidedBy };
  }
  return { matched: false };
}

/**
 * Evaluate a `paths-ignore:`-style list: the workflow is skipped only when
 * ALL changed files match the ignore list. Returns the first file that
 * escapes the ignore list (and therefore makes the workflow fire), if any.
 */
export function allFilesIgnored(patterns: readonly string[], files: readonly string[]): {
  allIgnored: boolean;
  escapingFile?: string;
} {
  for (const f of files) {
    const m = matchPatternList(patterns, f);
    if (!m.matched) return { allIgnored: false, escapingFile: f };
  }
  return { allIgnored: true };
}
