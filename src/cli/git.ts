/**
 * Git inference for the CLI. Every export degrades gracefully: on any git
 * failure (not a repo, detached HEAD, missing ref, git not installed) the
 * function returns null/undefined rather than throwing, so the caller can
 * fall back to honest "unknown" simulation instead of crashing.
 *
 * Node-only (uses child_process); never imported by the browser core.
 */

import { execFileSync } from "node:child_process";

/**
 * Run `git <args>` in `cwd`, returning trimmed stdout, or null if git exits
 * non-zero / is unavailable. stderr is swallowed so we never leak git noise.
 */
function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Large repos can produce long diffs; give room but stay bounded.
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** Split git output into a deduped list of non-empty, trimmed paths. */
function uniqLines(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Absolute path to the repository root, or null if `dir` is not in a repo. */
export function repoRoot(dir: string): string | null {
  return git(["rev-parse", "--show-toplevel"], dir);
}

/**
 * The checked-out branch name, or null when HEAD is detached (or `dir` is not
 * a repo). `-q` suppresses git's error on detached HEAD so we get a clean null.
 */
export function currentBranch(dir: string): string | null {
  const b = git(["symbolic-ref", "--short", "-q", "HEAD"], dir);
  return b && b.length > 0 ? b : null;
}

/** Resolve a ref like `@{push}` / `@{u}` to its short name (e.g. "origin/main"). */
function refName(ref: string, dir: string): string | null {
  return git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", ref], dir);
}

/** What a push's changed-file set was diffed against, for the header label. */
export interface ChangedFiles {
  files: string[];
  /** Human label, e.g. "vs upstream origin/main" or "last commit only (no upstream)". */
  source: string;
}

/**
 * Best-effort "what will this push contain": the commits ahead of the push
 * target. Tries, in order:
 *   1. `@{push}..HEAD`  — the branch's configured push destination
 *   2. `@{u}..HEAD`     — the tracking upstream (fetch side)
 *   3. `HEAD~1..HEAD`   — just the last commit, when there is no upstream
 *   4. the first commit's files, for single-commit repos (no HEAD~1)
 * Returns null only when even HEAD can't be read.
 */
export function changedFilesForPush(dir: string): ChangedFiles | null {
  const pushName = refName("@{push}", dir);
  if (pushName) {
    const out = git(["diff", "--name-only", "@{push}..HEAD"], dir);
    if (out !== null) {
      const files = uniqLines(out);
      if (files.length > 0) return { files, source: `vs upstream ${pushName}` };
      return { files: [], source: `no outgoing commits (in sync with ${pushName})` };
    }
  }

  const upName = refName("@{u}", dir);
  if (upName) {
    const out = git(["diff", "--name-only", "@{u}..HEAD"], dir);
    if (out !== null) {
      const files = uniqLines(out);
      if (files.length > 0) return { files, source: `vs upstream ${upName}` };
      return { files: [], source: `no outgoing commits (in sync with ${upName})` };
    }
  }

  // No upstream: fall back to the most recent commit.
  const fallback = lastCommitFiles(dir, "last commit only (no upstream)");
  if (fallback) return fallback;

  // Single-commit repo: HEAD has no parent, so show HEAD's own files.
  const out = git(["show", "--name-only", "--format=", "HEAD"], dir);
  if (out !== null) return { files: uniqLines(out), source: "first commit (all files)" };

  return null;
}

function lastCommitFiles(dir: string, source: string): ChangedFiles | null {
  const hasParent = git(["rev-parse", "--verify", "-q", "HEAD~1"], dir);
  if (hasParent === null) return null;
  const out = git(["diff", "--name-only", "HEAD~1..HEAD"], dir);
  if (out === null) return null;
  return { files: uniqLines(out), source };
}

/** Result of inferring a PR's changed files; `files` is null when it can't be diffed. */
export interface PrChangedFiles {
  files: string[] | null;
  source?: string;
  note?: string;
}

/**
 * Changed files for a PR: the three-dot (merge-base) diff of the base against
 * HEAD, matching what GitHub shows in the PR. If the base ref is unknown
 * locally, retry against `origin/<base>`; if that also fails, return
 * `files: null` with a note so paths filters honestly report UNKNOWN.
 */
export function changedFilesForPr(base: string, dir: string): PrChangedFiles {
  // `--end-of-options` stops git from parsing a user-supplied base that
  // starts with `-` (e.g. `--output=…`) as a flag. execFileSync already
  // prevents shell injection; this closes git-argument injection too.
  const direct = git(["diff", "--name-only", "--end-of-options", `${base}...HEAD`], dir);
  if (direct !== null) return { files: uniqLines(direct), source: `vs base ${base} (merge-base)` };

  const remote = git(["diff", "--name-only", "--end-of-options", `origin/${base}...HEAD`], dir);
  if (remote !== null) {
    return { files: uniqLines(remote), source: `vs base origin/${base} (merge-base)` };
  }

  return {
    files: null,
    note: `could not diff against base "${base}" (ref not found) — paths filters will be UNKNOWN (pass --files)`,
  };
}

/** The full HEAD commit message (`%B`), or null if HEAD can't be read. */
export function headCommitMessage(dir: string): string | null {
  const m = git(["log", "-1", "--pretty=%B"], dir);
  return m && m.length > 0 ? m : null;
}

/**
 * "owner/repo" parsed from the origin remote, for the github.repository
 * context. Handles both SSH (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo.git`) forms. Null for non-GitHub remotes.
 */
export function repoSlug(dir: string): string | null {
  const url = git(["remote", "get-url", "origin"], dir);
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * The repository's default branch, read from the origin/HEAD symbolic ref
 * (e.g. "origin/main" → "main"). Null when origin/HEAD isn't set locally.
 */
export function defaultBranch(dir: string): string | null {
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
  if (!r) return null;
  return r.replace(/^origin\//, "");
}
