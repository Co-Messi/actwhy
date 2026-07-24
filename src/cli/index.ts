/**
 * actwhy CLI entry point.
 *
 * Subcommands: `push` (default) and `pr`. Zero-config: infer branch, changed
 * files, commit message, repo slug and default branch from git; anything that
 * can't be inferred degrades to honest UNKNOWN rather than a guess.
 *
 * Built standalone by esbuild — no __dirname, no reading package.json at
 * runtime. The version is injected at build time via a `define`.
 */

// Injected by esbuild (`define: { ACTWHY_VERSION }`). Undefined when run
// straight from source (e.g. via tsx), so guard the reference.
declare const ACTWHY_VERSION: string;
const VERSION = typeof ACTWHY_VERSION === "undefined" ? "dev" : ACTWHY_VERSION;

import { parseArgs } from "node:util";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { evaluateWorkflows } from "../core/index.js";
import type { PrSpec, PushSpec, WorkflowFile } from "../core/index.js";
import * as git from "./git.js";
import { renderReport } from "./render.js";

type Subcommand = "push" | "pr";

/** parseArgs option shape; kept loose so a runtime-selected config type-checks. */
type OptConfig = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;

const SHARED: OptConfig = {
  repo: { type: "string", short: "C" },
  files: { type: "string", short: "f", multiple: true },
  event: { type: "string" },
  json: { type: "boolean" },
  steps: { type: "boolean" },
  "exit-code": { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
};

const PUSH_OPTS: OptConfig = {
  ...SHARED,
  branch: { type: "string", short: "b" },
  tag: { type: "string" },
  "commit-message": { type: "string", short: "m" },
};

const PR_OPTS: OptConfig = {
  ...SHARED,
  base: { type: "string" },
  head: { type: "string" },
  type: { type: "string" },
  draft: { type: "boolean" },
  target: { type: "boolean" },
};

function errln(s: string): void {
  process.stderr.write(s + "\n");
}

/** Exit-2 usage error: one line + the help pointer. */
function usage(msg: string): number {
  errln(`actwhy: ${msg}`);
  errln("run `actwhy --help` to see usage");
  return 2;
}

function colorEnabled(noColorFlag: boolean): boolean {
  if (noColorFlag) return false;
  // NO_COLOR convention: any non-empty value disables color.
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);

  // Peel the subcommand wherever it appears (`actwhy -C repo push` is as
  // valid as `actwhy push -C repo`). A lenient union-options pre-parse lets
  // flag VALUES that look like subcommands (e.g. `-b push`) be consumed as
  // values, so the first true positional reliably names the subcommand.
  let sub: Subcommand = "push";
  let rest = argv;
  try {
    const pre = parseArgs({
      args: argv,
      options: { ...PUSH_OPTS, ...PR_OPTS },
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    const firstPositional = pre.tokens.find((t) => t.kind === "positional");
    if (firstPositional) {
      const word = argv[firstPositional.index];
      if (word === "push" || word === "pr") {
        sub = word;
        rest = [...argv.slice(0, firstPositional.index), ...argv.slice(firstPositional.index + 1)];
      } else {
        return usage(`unknown command "${word}"`);
      }
    }
  } catch {
    // Fall through — the strict parse below reports the real error.
  }

  let values: Record<string, string | string[] | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      options: sub === "push" ? PUSH_OPTS : PR_OPTS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
  } catch (e) {
    // parseArgs appends a verbose "To specify a positional argument…" hint to
    // unknown-option errors; keep just the first sentence for a clean line.
    const raw = e instanceof Error ? e.message : String(e);
    return usage(raw.split(". To specify a positional")[0]);
  }

  if (values.help === true) {
    process.stdout.write(helpText());
    return 0;
  }
  if (values.version === true) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (positionals.length > 0) {
    return usage(`unexpected argument "${positionals[0]}"`);
  }

  const getStr = (k: string): string | undefined =>
    typeof values[k] === "string" ? (values[k] as string) : undefined;
  const getBool = (k: string): boolean => values[k] === true;
  const getArr = (k: string): string[] | undefined =>
    Array.isArray(values[k]) ? (values[k] as string[]) : undefined;

  // Locate the workflows directory (repo root, or the given dir if not a repo).
  const repoDir = resolve(getStr("repo") ?? process.cwd());
  const root = git.repoRoot(repoDir) ?? repoDir;
  const wfDir = join(root, ".github", "workflows");

  let entries: string[];
  try {
    entries = readdirSync(wfDir);
  } catch {
    errln(`actwhy: no .github/workflows in ${root}`);
    return 1;
  }
  const wfNames = entries.filter((n) => /\.ya?ml$/i.test(n)).sort();
  if (wfNames.length === 0) {
    errln(`actwhy: no workflow files (*.yml) in ${wfDir}`);
    return 1;
  }
  const files: WorkflowFile[] = wfNames.map((n) => ({
    name: n,
    content: readFileSync(join(wfDir, n), "utf8"),
  }));

  // --files replaces git inference. Flatten repeats/commas, drop blanks, dedupe.
  // An explicit-but-empty value ("") means a KNOWN-empty set ([]), which is
  // distinct from git-failure UNKNOWN (null).
  const filesFlag = parseFilesFlag(getArr("files"));

  // Optional JSON event payload merged into the spec.
  let payload: Record<string, unknown> | undefined;
  const eventPath = getStr("event");
  if (eventPath !== undefined) {
    const resolved = resolve(eventPath);
    // A GitHub event payload is at most a few hundred KB; cap the read so a
    // stray huge/binary path can't OOM the process.
    const MAX_EVENT_BYTES = 10 * 1024 * 1024;
    try {
      if (statSync(resolved).size > MAX_EVENT_BYTES) {
        return usage(`event file "${eventPath}" is too large (max 10 MB)`);
      }
    } catch {
      return usage(`could not read event file "${eventPath}"`);
    }
    let raw: string;
    try {
      raw = readFileSync(resolved, "utf8");
    } catch {
      return usage(`could not read event file "${eventPath}"`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return usage(`invalid JSON in event file "${eventPath}": ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return usage(`event file "${eventPath}" must contain a JSON object`);
    }
    payload = parsed as Record<string, unknown>;
  }

  const repository = git.repoSlug(root) ?? undefined;
  const defaultBranch = git.defaultBranch(root) ?? undefined;
  const notes: string[] = [];
  let filesSource: string | undefined;

  let spec: PushSpec | PrSpec;

  if (sub === "push") {
    const branchFlag = getStr("branch");
    const tagFlag = getStr("tag");
    if (branchFlag !== undefined && tagFlag !== undefined) {
      return usage("--branch and --tag are mutually exclusive");
    }

    let branch = branchFlag;
    const tag = tagFlag;
    if (branch === undefined && tag === undefined) {
      const cur = git.currentBranch(root);
      if (cur === null) {
        return usage(
          "cannot determine the current branch (detached HEAD or not a git repo) — pass --branch <name> or --tag <name>",
        );
      }
      branch = cur;
    }

    let pushFiles: string[] | null;
    if (filesFlag !== undefined) {
      pushFiles = filesFlag;
      filesSource = "from --files";
    } else {
      const inferred = git.changedFilesForPush(root);
      if (inferred) {
        pushFiles = inferred.files;
        filesSource = inferred.source;
      } else {
        pushFiles = null;
        notes.push("could not infer changed files from git — paths filters will be UNKNOWN (pass --files)");
      }
    }

    const commitMessage = getStr("commit-message") ?? git.headCommitMessage(root) ?? undefined;

    spec = {
      kind: "push",
      ...(branch !== undefined ? { branch } : {}),
      ...(tag !== undefined ? { tag } : {}),
      files: pushFiles,
      ...(commitMessage !== undefined ? { commitMessage } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
  } else {
    let base = getStr("base");
    if (base === undefined) {
      if (defaultBranch !== undefined) {
        base = defaultBranch;
        notes.push(`no --base given — using the repo default branch "${base}"`);
      } else {
        base = "main";
        notes.push('no --base given and no git default branch — assuming "main"');
      }
    }

    const head = getStr("head") ?? git.currentBranch(root) ?? undefined;
    const activityType = getStr("type") ?? "opened";
    const event = getBool("target") ? "pull_request_target" : "pull_request";

    let prFiles: string[] | null;
    if (filesFlag !== undefined) {
      prFiles = filesFlag;
      filesSource = "from --files";
    } else {
      const inferred = git.changedFilesForPr(base, root);
      prFiles = inferred.files;
      if (inferred.source) filesSource = inferred.source;
      if (inferred.note) notes.push(inferred.note);
    }

    spec = {
      kind: "pull_request",
      event,
      base,
      ...(head !== undefined ? { head } : {}),
      files: prFiles,
      activityType,
      ...(getBool("draft") ? { draft: true } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
  }

  const report = await evaluateWorkflows(files, spec, { steps: getBool("steps") });

  // Opt-in CI gate: exit 3 when a workflow failed to parse, exit 4 when
  // nothing fires. Default stays 0 so casual runs never look "failed".
  const gate = (): number => {
    if (!getBool("exit-code")) return 0;
    if (report.summary.workflowsError > 0) return 3;
    if (report.nothingFires) return 4;
    return 0;
  };

  if (getBool("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return gate();
  }

  const out = renderReport(report, {
    color: colorEnabled(getBool("no-color")),
    steps: getBool("steps"),
    filesSource,
    notes,
  });
  process.stdout.write(out + "\n");
  return gate();
}

/**
 * Normalize the repeatable, comma-separated --files flag into a deduped list,
 * or undefined when the flag was absent (→ fall back to git inference).
 */
function parseFilesFlag(vals: string[] | undefined): string[] | undefined {
  if (vals === undefined) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of vals) {
    for (const part of v.split(",")) {
      const t = part.trim();
      if (t.length > 0 && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

function helpText(): string {
  return `actwhy — know which GitHub Actions workflows fire, and exactly why the others don't.

USAGE
  actwhy [push] [options]      simulate a push to the current branch (default)
  actwhy pr [options]          simulate a pull_request

COMMON OPTIONS
  -C, --repo <dir>         repository to inspect (default: current directory)
  -f, --files <list>       comma-separated changed files (repeatable); overrides git
      --event <file.json>  merge a JSON event payload into the simulation
      --json               print the full report as JSON (no colors)
      --steps              also evaluate step-level \`if:\` conditions
      --exit-code          exit 3 if any workflow is invalid, 4 if nothing fires
      --no-color           disable ANSI colors
  -h, --help               show this help and exit
  -V, --version            print the version and exit

push OPTIONS
  -b, --branch <name>      branch being pushed (default: current git branch)
      --tag <name>         tag being pushed (mutually exclusive with --branch)
  -m, --commit-message <s> commit message to simulate (default: HEAD message)

pr OPTIONS
      --base <branch>      target branch (default: git default branch, else "main")
      --head <branch>      source branch (default: current git branch)
      --type <activity>    activity type: opened, synchronize, reopened … (default: opened)
      --draft              simulate a draft pull request
      --target             simulate pull_request_target instead of pull_request

EXAMPLES
  actwhy                                    zero-config: current branch + outgoing changes
  actwhy push -b main                       simulate pushing to the main branch
  actwhy push --tag v1.2.0                  simulate pushing a tag
  actwhy push -f src/app.ts,README.md       override the changed-file set
  actwhy pr --base main                     simulate opening a PR against main
  actwhy pr --base main --type synchronize --steps    PR sync event, with step detail

Docs: https://actwhy.vercel.app
`;
}

// actwhy uses `util.parseArgs({ tokens })` and other Node ≥20 APIs. Give a
// clear message instead of a cryptic runtime crash on older runtimes.
const major = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(major) && major < 20) {
  process.stderr.write(
    pc.red(`actwhy requires Node.js ≥ 20 (you have ${process.versions.node}).`) + "\n",
  );
  process.exit(1);
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(pc.red(`actwhy: ${msg}`) + "\n");
    process.exit(1);
  });
