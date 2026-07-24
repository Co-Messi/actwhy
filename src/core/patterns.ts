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
 *
 * Matching runs on a Thompson-style NFA simulation, NOT a backtracking
 * RegExp: worst case is O(pattern length × value length) no matter what a
 * (possibly hostile) workflow file puts in a filter. Patterns come from
 * untrusted repos, so catastrophic backtracking must be impossible by
 * construction, not by convention.
 */

type Quant = "" | "?" | "+" | "*";

interface Atom {
  /** Predicate for one character. */
  test: (c: string) => boolean;
  quant: Quant;
  /**
   * A slash-delimited globstar is zero or more complete path segments,
   * including the separating slash. Keeping that construct explicit avoids
   * making the slash mandatory when it matches zero directories.
   */
  directoryGlobstar?: boolean;
}

export interface CompiledPattern {
  /** Original pattern text (without a leading `!`). */
  source: string;
  negative: boolean;
  /** Anchored match against the whole value. Linear time, no backtracking. */
  test: (value: string) => boolean;
}

/** Language-equivalent collapse of a second quantifier onto an atom. */
function addQuantifier(quant: Quant, q: "?" | "+"): Quant {
  switch (quant) {
    case "":
      return q;
    case "?":
      return q === "?" ? "?" : "*"; // (a?)? ≡ a?, (a?)+ ≡ a*
    case "+":
      return q === "?" ? "*" : "+"; // (a+)? ≡ a*, (a+)+ ≡ a+
    case "*":
      return "*"; // (a*)? ≡ (a*)+ ≡ a* — also covers `*?` / `*+` / `**+`
  }
}

function literal(ch: string): Atom["test"] {
  return (c) => c === ch;
}

const NOT_SLASH: Atom["test"] = (c) => c !== "/";
const ANY: Atom["test"] = () => true;

/**
 * Build a predicate for a `[...]` class body with `-` ranges. A leading `^`
 * is treated as a literal member — GitHub does not document class negation,
 * and guessing negation semantics would risk a confidently-wrong verdict.
 */
function charClass(body: string): Atom["test"] {
  const singles = new Set<string>();
  const ranges: Array<[string, string]> = [];
  let i = 0;
  while (i < body.length) {
    let c = body[i];
    if (c === "\\" && i + 1 < body.length) {
      c = body[i + 1];
      i++;
    }
    if (i + 2 < body.length && body[i + 1] === "-") {
      ranges.push([c, body[i + 2]]);
      i += 3;
      continue;
    }
    singles.add(c);
    i++;
  }
  return (c) => singles.has(c) || ranges.some(([lo, hi]) => c >= lo && c <= hi);
}

function parseAtoms(pattern: string, original: string): Atom[] {
  const atoms: Atom[] = [];
  const push = (test: Atom["test"], quant: Quant = ""): void => {
    atoms.push({ test, quant });
  };
  const last = (): Atom | undefined => atoms[atoms.length - 1];

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      let stars = 0;
      while (pattern[i] === "*") {
        stars++;
        i++;
      }
      if (stars >= 2 && pattern[i] === "/") {
        atoms.push({ test: ANY, quant: "*", directoryGlobstar: true });
        i++;
        continue;
      }
      push(stars >= 2 ? ANY : NOT_SLASH, "*");
      continue;
    }
    if (c === "?" || c === "+") {
      const prev = last();
      if (prev === undefined) {
        // No preceding atom — GitHub treats this as a literal character.
        push(literal(c));
      } else {
        prev.quant = addQuantifier(prev.quant, c);
      }
      i++;
      continue;
    }
    if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        throw new Error(`Unterminated character class in pattern "${original}"`);
      }
      push(charClass(pattern.slice(i + 1, close)));
      i = close + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= pattern.length) {
        throw new Error(`Trailing backslash in pattern "${original}"`);
      }
      push(literal(pattern[i + 1]));
      i += 2;
      continue;
    }
    push(literal(c));
    i++;
  }
  return atoms;
}

/** True when the atom can match the empty string. */
function canBeEmpty(a: Atom): boolean {
  return a.directoryGlobstar === true || a.quant === "?" || a.quant === "*";
}

/**
 * Anchored NFA simulation. `state[j]` = "atoms[0..j) have consumed the
 * input so far". Epsilon closure skips atoms that may match empty;
 * `+`/`*` atoms may re-consume without advancing.
 */
function matchAtoms(atoms: Atom[], value: string): boolean {
  const n = atoms.length;
  let state = new Array<boolean>(n + 1).fill(false);
  let partial = new Array<boolean>(n).fill(false);
  state[0] = true;
  for (let j = 0; j < n; j++) state[j + 1] = state[j] && canBeEmpty(atoms[j]);

  for (const c of value) {
    const next = new Array<boolean>(n + 1).fill(false);
    const nextPartial = new Array<boolean>(n).fill(false);
    for (let j = 0; j < n; j++) {
      const a = atoms[j];
      if (a.directoryGlobstar) {
        if (state[j] || partial[j]) {
          nextPartial[j] = true;
          if (c === "/") next[j + 1] = true;
        }
        continue;
      }
      if (!a.test(c)) continue;
      // Enter atom j from "before it"…
      if (state[j]) next[j + 1] = true;
      // …or repeat it, for + / * quantifiers.
      if ((a.quant === "+" || a.quant === "*") && state[j + 1]) next[j + 1] = true;
    }
    for (let j = 0; j < n; j++) {
      if (next[j] && canBeEmpty(atoms[j])) next[j + 1] = true;
    }
    state = next;
    partial = nextPartial;
    if (!state.includes(true) && !partial.includes(true)) return false;
  }
  return state[n];
}

/** Compiled-pattern memo — filter lists are re-checked per changed file. */
const cache = new Map<string, CompiledPattern>();
const CACHE_MAX = 2000;

/**
 * Compile one GitHub filter pattern.
 * Throws on malformed patterns (unterminated `[` class, trailing `\`).
 */
export function compilePattern(pattern: string): CompiledPattern {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let negative = false;
  let p = pattern;
  if (p.startsWith("!")) {
    negative = true;
    p = p.slice(1);
  }
  const atoms = parseAtoms(p, pattern);
  const compiled: CompiledPattern = {
    source: p,
    negative,
    test: (value) => matchAtoms(atoms, value),
  };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(pattern, compiled);
  return compiled;
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
    if (cp.test(value)) {
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
