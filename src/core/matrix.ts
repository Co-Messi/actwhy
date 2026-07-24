/**
 * Static matrix expansion. Computes the number of variants for a job's
 * `strategy.matrix` when it is fully static; anything dynamic
 * (`fromJSON(...)`, expressions) is reported honestly as unknown.
 */

import type { TemplateToken } from "@actions/workflow-parser/templates/tokens/template-token";
import {
  isBasicExpression,
  isMapping,
  isSequence,
  isString,
  isNumber,
  isBoolean,
} from "@actions/workflow-parser";

export interface MatrixResult {
  count: number | "unknown";
  note?: string;
  /** Set when the static variant count exceeds GitHub's hard 256-job cap. */
  overLimit?: boolean;
}

/** GitHub rejects any matrix that would generate more than 256 jobs. */
const GITHUB_MATRIX_LIMIT = 256;

type Combo = Record<string, string>;

function scalarKey(t: TemplateToken): string | null {
  if (isString(t)) return t.value;
  if (isNumber(t)) return String(t.value);
  if (isBoolean(t)) return String(t.value);
  return null;
}

/** Serialize a mapping token of scalars into a partial combo, or null if dynamic. */
function comboOf(t: TemplateToken): Combo | null {
  if (!isMapping(t)) return null;
  const combo: Combo = {};
  for (const pair of t) {
    const key = scalarKey(pair.key);
    const value = scalarKey(pair.value);
    if (key === null || value === null) return null;
    combo[key] = value;
  }
  return combo;
}

function comboMatches(partial: Combo, combo: Combo): boolean {
  return Object.entries(partial).every(([k, v]) => combo[k] === v);
}

export function expandMatrix(strategy: TemplateToken | undefined): MatrixResult | undefined {
  if (strategy === undefined) return undefined;
  if (!isMapping(strategy)) {
    return { count: "unknown", note: "strategy is an expression — resolved at runtime" };
  }
  let matrixToken: TemplateToken | undefined;
  for (const pair of strategy) {
    if (scalarKey(pair.key) === "matrix") matrixToken = pair.value;
  }
  if (matrixToken === undefined) return undefined;
  if (isBasicExpression(matrixToken)) {
    return {
      count: "unknown",
      note: `matrix comes from an expression (${truncate(matrixToken.expression)}) — resolved at runtime`,
    };
  }
  if (!isMapping(matrixToken)) return { count: "unknown", note: "matrix has an unexpected shape" };

  const axes: [string, string[]][] = [];
  let includes: Combo[] = [];
  let excludes: Combo[] = [];

  for (const pair of matrixToken) {
    const key = scalarKey(pair.key);
    if (key === null) return { count: "unknown", note: "matrix key is dynamic" };
    const value = pair.value;
    if (key === "include" || key === "exclude") {
      if (isBasicExpression(value)) {
        return {
          count: "unknown",
          note: `matrix ${key} comes from an expression — resolved at runtime`,
        };
      }
      if (!isSequence(value)) return { count: "unknown", note: `matrix ${key} has an unexpected shape` };
      const combos: Combo[] = [];
      for (const item of value) {
        const c = comboOf(item);
        if (c === null) {
          return { count: "unknown", note: `matrix ${key} contains dynamic entries` };
        }
        combos.push(c);
      }
      if (key === "include") includes = combos;
      else excludes = combos;
      continue;
    }
    if (isBasicExpression(value)) {
      return {
        count: "unknown",
        note: `matrix axis "${key}" comes from an expression — resolved at runtime`,
      };
    }
    if (!isSequence(value)) return { count: "unknown", note: `matrix axis "${key}" has an unexpected shape` };
    const values: string[] = [];
    for (const item of value) {
      const s = scalarKey(item);
      if (s === null) {
        // Object axis values (e.g. lists of objects) still count as one
        // variant each; only expressions make the count unknown.
        if (isBasicExpression(item)) {
          return {
            count: "unknown",
            note: `matrix axis "${key}" contains an expression — resolved at runtime`,
          };
        }
        values.push(`#${values.length}`);
      } else {
        values.push(s);
      }
    }
    axes.push([key, values]);
  }

  // Cross product.
  let combos: Combo[] = [{}];
  for (const [key, values] of axes) {
    const next: Combo[] = [];
    for (const combo of combos) {
      for (const v of values) next.push({ ...combo, [key]: v });
    }
    combos = next;
    // Hard stop well past GitHub's cap to bound work on a pathological matrix;
    // anything this large is already over-limit (flagged below).
    if (combos.length > 100_000) {
      return {
        count: "unknown",
        overLimit: true,
        note: `matrix exceeds GitHub's ${GITHUB_MATRIX_LIMIT}-job limit`,
      };
    }
  }

  // Exclude: remove combos matching any exclude entry (partial match).
  combos = combos.filter((c) => !excludes.some((ex) => comboMatches(ex, c)));

  // Include entries that don't extend an existing combo add new variants.
  // (Entries whose overlapping keys match an existing combo only extend it.)
  let added = 0;
  for (const inc of includes) {
    const axisKeys = Object.keys(inc).filter((k) => axes.some(([a]) => a === k));
    const extendsExisting =
      combos.length > 0 &&
      combos.some((c) => axisKeys.every((k) => c[k] === inc[k]));
    if (!extendsExisting) added++;
  }

  const count = combos.length + added;
  if (count > GITHUB_MATRIX_LIMIT) {
    return {
      count,
      overLimit: true,
      note: `exceeds GitHub's ${GITHUB_MATRIX_LIMIT}-job limit — GitHub would fail this workflow`,
    };
  }
  const note =
    excludes.length > 0 || includes.length > 0
      ? `after ${excludes.length ? `exclude` : ""}${excludes.length && includes.length ? " + " : ""}${includes.length ? `include` : ""}`
      : undefined;
  return { count, note };
}

function truncate(s: string): string {
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}
