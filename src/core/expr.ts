/**
 * Tri-state evaluation of GitHub Actions expressions.
 *
 * We parse with GitHub's own `@actions/expressions` parser and walk its AST
 * with a three-valued evaluator: every node yields a KNOWN value, or an
 * UNKNOWN carrying (a) Kleene truthiness when it is still decidable and
 * (b) the exact runtime-only context paths responsible.
 *
 * Value semantics for known operands delegate to the library's own
 * `equals` / `lessThan` / `greaterThan` / `falsy` implementations and
 * `wellKnownFunctions`, so coercion rules (case-insensitive string
 * equality, string→number loose comparison, …) are GitHub's, not ours.
 */

import {
  Binary,
  ContextAccess,
  Expr,
  ExprVisitor,
  FunctionCall,
  Grouping,
  IndexAccess,
  Literal,
  Logical,
  Star,
  Unary,
} from "@actions/expressions/ast";
import * as data from "@actions/expressions/data/index";
import { Lexer } from "@actions/expressions/lexer";
import { Parser } from "@actions/expressions/parser";
import { TokenType } from "@actions/expressions/lexer";
import { equals, falsy, greaterThan, lessThan, truthy } from "@actions/expressions/result";
import { wellKnownFunctions } from "@actions/expressions/funcs";
import { CtxValue, PartialDict, RootContext, Unk } from "./context.js";

export type Truthiness = boolean | "unknown";

export type TriValue =
  | { known: true; value: data.ExpressionData }
  | { known: false; truthiness: Truthiness; deps: UnknownDep[] };

export interface UnknownDep {
  /** Dotted context path, e.g. "secrets.DEPLOY_KEY". */
  path: string;
  why: string;
  hint?: string;
}

/** Assumed job/step statuses for status functions under simulation. */
export interface StatusAssumptions {
  /** success() — false when a needed job was skipped. */
  success: Truthiness;
  /** failure() — false under the happy-path assumption. */
  failure: Truthiness;
  cancelled: Truthiness;
}

export interface EvalOutcome {
  /** Truthiness of the whole expression. */
  truthiness: Truthiness;
  /** Runtime-only paths the result depends on (when truthiness is unknown). */
  deps: UnknownDep[];
  /** Which status functions the expression used (success/failure/…). */
  statusFnsUsed: Set<string>;
  /**
   * Known context values that were read while evaluating — used to build
   * "github.ref was 'refs/heads/main'" explanations.
   */
  reads: Map<string, string>;
  /** Set when the expression is a template that can never be false. */
  footgun?: string;
  /** Parse/evaluation error, if any. */
  error?: string;
}

const CONTEXT_NAMES = [
  "github", "needs", "strategy", "matrix", "steps", "job", "jobs",
  "runner", "env", "vars", "secrets", "inputs",
];

const STATUS_FNS = new Set(["success", "failure", "cancelled", "always"]);

const EXTENSION_FNS = [
  { name: "success", minArgs: 0, maxArgs: 0 },
  { name: "failure", minArgs: 0, maxArgs: 0 },
  { name: "cancelled", minArgs: 0, maxArgs: 0 },
  { name: "always", minArgs: 0, maxArgs: 0 },
  { name: "hashFiles", minArgs: 1, maxArgs: 255 },
];

export function parseExpression(expression: string): Expr {
  const lexer = new Lexer(expression);
  const parser = new Parser(lexer.lex().tokens, CONTEXT_NAMES, EXTENSION_FNS);
  return parser.parse();
}

function known(value: data.ExpressionData): TriValue {
  return { known: true, value };
}

function unknown(truthiness: Truthiness, deps: UnknownDep[]): TriValue {
  return { known: false, truthiness, deps };
}

/** Convert a fully-known plain context value to the library's data model. */
function toData(v: CtxValue): data.ExpressionData | Unk | PartialDict {
  if (v instanceof Unk || v instanceof PartialDict) return v;
  if (v === null) return new data.Null();
  if (typeof v === "string") return new data.StringData(v);
  if (typeof v === "number") return new data.NumberData(v);
  if (typeof v === "boolean") return new data.BooleanData(v);
  if (Array.isArray(v)) {
    const arr = new data.Array();
    for (const item of v) {
      const d = toData(item);
      if (d instanceof Unk || d instanceof PartialDict) return new Unk("contains runtime-only entries");
      arr.add(d);
    }
    return arr;
  }
  const dict = new data.Dictionary();
  for (const [k, val] of Object.entries(v)) {
    const d = toData(val);
    if (d instanceof Unk || d instanceof PartialDict) {
      // A container with runtime-only members can still be indexed member-
      // by-member (handled by the resolver); as a VALUE it is unknown.
      return new Unk("contains runtime-only entries");
    }
    dict.add(k, d);
  }
  return dict;
}

export class TriEvaluator implements ExprVisitor<TriValue> {
  readonly statusFnsUsed = new Set<string>();
  readonly reads = new Map<string, string>();

  constructor(
    private readonly context: RootContext,
    private readonly statuses: StatusAssumptions,
  ) {}

  evaluate(expr: Expr): TriValue {
    return expr.accept(this);
  }

  // ── leaves ────────────────────────────────────────────────────────────

  visitLiteral(literal: Literal): TriValue {
    return known(literal.literal);
  }

  visitContextAccess(contextAccess: ContextAccess): TriValue {
    return this.resolvePath([contextAccess.name.lexeme]);
  }

  visitIndexAccess(ia: IndexAccess): TriValue {
    const path = this.staticPath(ia);
    if (path) return this.resolvePath(path);

    // Dynamic index (e.g. a[b]) — resolve base and index separately.
    const base = this.evaluate(ia.expr);
    const index = this.evaluate(ia.index);
    if (!base.known) return unknown("unknown", base.deps);
    if (!index.known) return unknown("unknown", index.deps);
    return this.indexInto(base.value, index.value);
  }

  visitGrouping(grouping: Grouping): TriValue {
    return this.evaluate(grouping.group);
  }

  // ── operators ─────────────────────────────────────────────────────────

  visitUnary(unary: Unary): TriValue {
    const v = this.evaluate(unary.expr);
    // The only unary operator is `!`.
    if (v.known) return known(new data.BooleanData(falsy(v.value)));
    if (v.truthiness === "unknown") return v;
    return unknown(!v.truthiness, v.deps);
  }

  visitBinary(binary: Binary): TriValue {
    const l = this.evaluate(binary.left);
    const r = this.evaluate(binary.right);
    if (!l.known || !r.known) {
      const deps = [...(l.known ? [] : l.deps), ...(r.known ? [] : r.deps)];
      return unknown("unknown", deps);
    }
    const a = l.value;
    const b = r.value;
    let result: boolean;
    switch (binary.operator.type) {
      case TokenType.EQUAL_EQUAL: result = equals(a, b); break;
      case TokenType.BANG_EQUAL: result = !equals(a, b); break;
      case TokenType.GREATER: result = greaterThan(a, b); break;
      case TokenType.GREATER_EQUAL: result = greaterThan(a, b) || equals(a, b); break;
      case TokenType.LESS: result = lessThan(a, b); break;
      case TokenType.LESS_EQUAL: result = lessThan(a, b) || equals(a, b); break;
      default:
        return unknown("unknown", [{ path: "(expression)", why: `unsupported operator ${binary.operator.lexeme}` }]);
    }
    return known(new data.BooleanData(result));
  }

  visitLogical(logical: Logical): TriValue {
    const isAnd = logical.operator.type === TokenType.AND;
    // GitHub's && / || return operand VALUES (first falsy / first truthy).
    // With unknowns in play we still compute Kleene truthiness.
    const deps: UnknownDep[] = [];
    let sawUndecided = false;
    let last: TriValue | undefined;
    for (const arg of logical.args) {
      const v = this.evaluate(arg);
      last = v;
      if (v.known) {
        const t = truthy(v.value);
        // Deciding operand: first falsy for &&, first truthy for ||.
        if (isAnd && !t) return sawUndecided ? unknown(false, deps) : v;
        if (!isAnd && t) return sawUndecided ? unknown(true, deps) : v;
        // Neutral operand: continue.
      } else {
        deps.push(...v.deps);
        if (v.truthiness === (isAnd ? false : true)) {
          // Unknown value but decided truthiness — decides the result.
          return unknown(v.truthiness, deps);
        }
        if (v.truthiness === "unknown") sawUndecided = true;
        // Unknown-but-neutral (truthy for &&, falsy for ||): continue.
      }
    }
    if (sawUndecided) return unknown("unknown", deps);
    // No operand decided: the result is the last operand's value.
    return last ?? known(new data.Null());
  }

  // ── functions ─────────────────────────────────────────────────────────

  visitFunctionCall(functionCall: FunctionCall): TriValue {
    const name = functionCall.functionName.lexeme.toLowerCase();

    if (STATUS_FNS.has(name)) {
      this.statusFnsUsed.add(name);
      if (name === "always") return known(new data.BooleanData(true));
      const t = this.statuses[name as keyof StatusAssumptions];
      if (t === "unknown") {
        return unknown("unknown", [{ path: `${name}()`, why: "depends on runtime job results" }]);
      }
      return known(new data.BooleanData(t));
    }

    if (name === "hashfiles") {
      return unknown("unknown", [{ path: "hashFiles(…)", why: "file hashes are computed on the runner" }]);
    }

    const args: data.ExpressionData[] = [];
    const deps: UnknownDep[] = [];
    for (const argExpr of functionCall.args) {
      const v = this.evaluate(argExpr);
      if (!v.known) deps.push(...v.deps);
      else args.push(v.value);
    }
    if (deps.length > 0) return unknown("unknown", deps);

    const fn = wellKnownFunctions[name];
    if (!fn) {
      return unknown("unknown", [{ path: `${name}()`, why: "unrecognized function" }]);
    }
    try {
      return known(fn.call(...args));
    } catch (e) {
      return unknown("unknown", [
        { path: `${name}(…)`, why: `evaluation failed: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    }
  }

  // ── context resolution ────────────────────────────────────────────────

  /** Extract a static dotted path from nested Context/Index accesses. */
  private staticPath(expr: Expr): string[] | null {
    if (expr instanceof ContextAccess) return [expr.name.lexeme];
    if (expr instanceof IndexAccess) {
      const base = this.staticPath(expr.expr);
      if (!base) return null;
      if (expr.index instanceof Star) return [...base, "*"];
      if (expr.index instanceof Literal) {
        const lit = expr.index.literal;
        if (lit.kind === data.Kind.String) return [...base, (lit as data.StringData).value];
        if (lit.kind === data.Kind.Number) return [...base, String((lit as data.NumberData).value)];
      }
      return null;
    }
    return null;
  }

  private resolvePath(path: string[]): TriValue {
    if (path.includes("*")) return this.resolveFilteredPath(path);

    const dotted = path.join(".");
    let node: CtxValue | undefined = this.context[path[0]];
    if (node === undefined) return known(new data.Null());

    for (let i = 1; i < path.length; i++) {
      const key = path[i];
      if (node instanceof Unk) {
        return unknown("unknown", [{ path: rootPath(path, i), why: node.why, hint: node.hint }]);
      }
      if (node instanceof PartialDict) {
        if (key in node.entries) {
          node = node.entries[key];
        } else {
          return unknown("unknown", [{ path: dotted, why: node.why, hint: node.hint }]);
        }
        continue;
      }
      if (node !== null && typeof node === "object" && !Array.isArray(node)) {
        node = (node as Record<string, CtxValue>)[key] ?? null;
        continue;
      }
      if (Array.isArray(node)) {
        const idx = Number(key);
        node = Number.isInteger(idx) ? (node[idx] ?? null) : null;
        continue;
      }
      // Indexing into a primitive yields null in GitHub's evaluator.
      node = null;
    }

    if (node instanceof Unk) {
      return unknown("unknown", [{ path: dotted, why: node.why, hint: node.hint }]);
    }
    if (node instanceof PartialDict) {
      return unknown("unknown", [{ path: dotted, why: node.why, hint: node.hint }]);
    }
    const d = toData(node);
    if (d instanceof Unk || d instanceof PartialDict) {
      return unknown("unknown", [{ path: dotted, why: d instanceof Unk ? d.why : d.why }]);
    }
    if (d.primitive) this.reads.set(dotted, d.coerceString());
    return known(d);
  }

  /**
   * Resolve GitHub's object-filter syntax (`labels.*.name`) without calling
   * Star.accept(), which the upstream AST intentionally leaves unimplemented.
   */
  private resolveFilteredPath(path: string[]): TriValue {
    const dotted = path.join(".");
    let nodes: CtxValue[] = [this.context[path[0]] ?? null];
    let filtering = false;

    for (let i = 1; i < path.length; i++) {
      const key = path[i];
      const next: CtxValue[] = [];

      for (const node of nodes) {
        if (node instanceof Unk) {
          return unknown("unknown", [
            { path: dotted, why: node.why, hint: node.hint },
          ]);
        }

        if (key === "*") {
          filtering = true;
          if (node instanceof PartialDict) {
            return unknown("unknown", [
              { path: dotted, why: node.why, hint: node.hint },
            ]);
          }
          if (Array.isArray(node)) {
            next.push(...node);
          } else if (node !== null && typeof node === "object") {
            next.push(...Object.values(node as Record<string, CtxValue>));
          }
          continue;
        }

        if (node instanceof PartialDict) {
          if (key in node.entries) {
            next.push(node.entries[key]);
          } else {
            return unknown("unknown", [
              { path: dotted, why: node.why, hint: node.hint },
            ]);
          }
          continue;
        }
        if (node !== null && typeof node === "object" && !Array.isArray(node)) {
          const record = node as Record<string, CtxValue>;
          if (key in record) next.push(record[key]);
          else if (!filtering) next.push(null);
          continue;
        }
        if (Array.isArray(node)) {
          const index = Number(key);
          if (Number.isInteger(index) && index >= 0 && index < node.length) {
            next.push(node[index]);
          } else if (!filtering) {
            next.push(null);
          }
          continue;
        }
        if (!filtering) next.push(null);
      }
      nodes = next;
    }

    const value = toData(nodes);
    if (value instanceof Unk || value instanceof PartialDict) {
      return unknown("unknown", [{ path: dotted, why: value.why }]);
    }
    return known(value);
  }

  private indexInto(base: data.ExpressionData, index: data.ExpressionData): TriValue {
    if (base.kind === data.Kind.Dictionary || (base.kind as data.Kind) === data.Kind.CaseSensitiveDictionary) {
      const dict = base as data.Dictionary;
      const key = index.coerceString();
      const v = dict.get(key);
      return known(v ?? new data.Null());
    }
    if (base.kind === data.Kind.Array) {
      const arr = base as data.Array;
      const i = index.number();
      const values = arr.values();
      if (Number.isInteger(i) && i >= 0 && i < values.length) return known(values[i]);
      return known(new data.Null());
    }
    return known(new data.Null());
  }
}

function rootPath(path: string[], unknownAt: number): string {
  return path.slice(0, unknownAt === 0 ? 1 : unknownAt).join(".") +
    (unknownAt < path.length ? "." + path.slice(unknownAt).join(".") : "");
}

/**
 * Detect the classic always-true template footgun. The workflow parser
 * compiles a mixed `if:` template like
 *     if: ${{ github.ref }} == 'refs/heads/main'
 * into  format('{0} == ''refs/heads/main''', github.ref)
 * whose result is a non-empty STRING — truthy no matter what the
 * subexpression evaluates to.
 */
function detectFormatFootgun(expr: Expr): string | undefined {
  // Unwrap the parser's implicit `success() && (…)` wrapper.
  let node: Expr = expr;
  if (node instanceof Logical && node.args.length === 2) {
    const [first, second] = node.args;
    if (
      first instanceof FunctionCall &&
      STATUS_FNS.has(first.functionName.lexeme.toLowerCase())
    ) {
      node = second;
    }
  }
  while (node instanceof Grouping) node = node.group;
  if (node instanceof FunctionCall && node.functionName.lexeme.toLowerCase() === "format") {
    const fmt = node.args[0];
    if (fmt instanceof Literal && fmt.literal.kind === data.Kind.String) {
      const text = (fmt.literal as data.StringData).value;
      const staticText = text.replace(/\{\d+\}/g, "").trim();
      if (staticText.length > 0) {
        // Reconstruct a readable approximation of what the author wrote.
        const pretty = text.replace(/''/g, "'").replace(/\{\d+\}/g, "${{ … }}");
        const shown = pretty.length > 70 ? pretty.slice(0, 67) + "…" : pretty;
        return (
          `this condition mixes text and \${{ }} — it evaluates to the STRING ` +
          `\`${shown}\`, which is non-empty and therefore ALWAYS truthy. ` +
          `Wrap the whole condition in a single \${{ }} (or none at all).`
        );
      }
    }
  }
  return undefined;
}

/**
 * Evaluate an `if:` expression (as normalized by @actions/workflow-parser,
 * i.e. already unwrapped from `${{ }}`).
 */
export function evaluateIf(
  expression: string,
  context: RootContext,
  statuses: StatusAssumptions,
): EvalOutcome {
  let expr: Expr;
  try {
    expr = parseExpression(expression);
  } catch (e) {
    return {
      truthiness: "unknown",
      deps: [],
      statusFnsUsed: new Set(),
      reads: new Map(),
      error: `could not parse expression: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const evaluator = new TriEvaluator(context, statuses);
  let result: TriValue;
  try {
    result = evaluator.evaluate(expr);
  } catch (e) {
    return {
      truthiness: "unknown",
      deps: [],
      statusFnsUsed: evaluator.statusFnsUsed,
      reads: evaluator.reads,
      error: `evaluation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const footgun = detectFormatFootgun(expr);
  if (result.known) {
    return {
      truthiness: truthy(result.value),
      deps: [],
      statusFnsUsed: evaluator.statusFnsUsed,
      reads: evaluator.reads,
      footgun,
    };
  }
  return {
    truthiness: result.truthiness,
    deps: dedupeDeps(result.deps),
    statusFnsUsed: evaluator.statusFnsUsed,
    reads: evaluator.reads,
    footgun,
  };
}

function dedupeDeps(deps: UnknownDep[]): UnknownDep[] {
  const seen = new Map<string, UnknownDep>();
  for (const d of deps) if (!seen.has(d.path)) seen.set(d.path, d);
  return [...seen.values()];
}
