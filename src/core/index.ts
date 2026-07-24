/** Public core API — browser-safe. */
export { evaluateWorkflows } from "./evaluate.js";
export { evaluateTrigger, describeTriggers } from "./filters.js";
export { compilePattern, matchPatternList, anyFileMatches, allFilesIgnored } from "./patterns.js";
export { evaluateIf, parseExpression, TriEvaluator } from "./expr.js";
export { buildRootContext, Unk, PartialDict } from "./context.js";
export { expandMatrix } from "./matrix.js";
export type {
  EventSpec,
  PushSpec,
  PrSpec,
  Report,
  ReportSummary,
  Reason,
  VerdictKind,
  WorkflowVerdict,
  JobVerdict,
  StepVerdict,
  WorkflowFile,
  EvaluateOptions,
} from "./types.js";
