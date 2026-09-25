/** Shared domain types for the AI-generated-code review verifier. */

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export type FindingSource = "rule" | "llm" | "mutation" | "test";

export interface Finding {
  id: string;
  source: FindingSource;
  severity: RiskLevel;
  file: string;
  /** 1-indexed line number in the "after" version of the file, when known. */
  line?: number;
  title: string;
  detail: string;
  /** Freeform evidence: a code excerpt, a survived mutant diff, a failing assertion, etc. */
  evidence?: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff lines including the leading +/-/space marker. */
  lines: string[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  isBinary: boolean;
  hunks: DiffHunk[];
  /** Line numbers (in the "after" file) touched by additions or context-adjacent changes. */
  changedLines: number[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

export type FunctionKind = "function" | "method" | "arrow" | "constructor";

export interface ChangedFunction {
  id: string;
  file: string;
  name: string;
  kind: FunctionKind;
  startLine: number;
  endLine: number;
  /** Full source text of the function as it exists after the PR. */
  sourceText: string;
  params: ParamInfo[];
  returnTypeText: string | null;
  isAsync: boolean;
  isExported: boolean;
  /** True if the diff touched lines inside this function's range. */
  directlyChanged: boolean;
}

export interface ParamInfo {
  name: string;
  typeText: string | null;
  optional: boolean;
  hasDefault: boolean;
}

export interface TrivialCheckResult {
  isTrivial: boolean;
  reasons: string[];
}

export interface RiskClassification {
  riskLevel: RiskLevel;
  summary: string;
  intent: string;
  findings: Finding[];
  /** true when produced by the deterministic rule engine instead of an LLM call. */
  fromFallback: boolean;
  /** No model assessment exists (budget exhausted, every request refused/incomplete): score as unknown, not clean. */
  skipped?: boolean;
  modelId?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Billed cost of the call(s), priced for the model that actually ran. */
  costUsd?: number;
}

export interface GeneratedTestFile {
  targetFunctionId: string;
  file: string;
  content: string;
  kind: "edge-case" | "property";
}

export interface TestRunResult {
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  failures: { testName: string; message: string }[];
}

export interface MutationResult {
  mutationScore: number; // 0-100
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  totalMutants: number;
  survivedMutants: SurvivedMutant[];
  durationMs: number;
}

export interface SurvivedMutant {
  id: string;
  file: string;
  line: number;
  mutatorName: string;
  originalCode: string;
  mutatedCode: string;
  /** "NoCoverage": no test even executed the mutated code. Absent in reports from older versions. */
  status?: "Survived" | "NoCoverage";
}

export interface TrustScoreBreakdown {
  score: number; // 0-100
  label: "trusted" | "needs-review" | "high-risk";
  components: {
    llmRisk: number;
    mutationCoverage: number;
    testHealth: number;
    ruleFlags: number;
  };
  evidence: Finding[];
}

export interface ExecutionInfo {
  /** Which sandbox executor ran (or would have run) generated tests / mutation testing. */
  executor: "local" | "docker" | "none";
  isolated: boolean;
  /** Set when code execution was skipped entirely, e.g. an untrusted PR with no isolated sandbox configured. */
  skippedReason?: string;
  /** Non-fatal problems during execution (install failed, suite already failing, unsupported runner, ...). */
  notes?: string[];
}

export interface ReviewResult {
  id: string;
  repo: string;
  prNumber: number;
  headSha: string;
  createdAt: string;
  isTrivial: boolean;
  trivialReasons: string[];
  risk?: RiskClassification;
  changedFunctions: ChangedFunction[];
  generatedTests: GeneratedTestFile[];
  testRun?: TestRunResult;
  /** Mutation testing of the generated tests (diff-only mode). */
  mutation?: MutationResult;
  /**
   * Mutation testing of the PR's changed lines against the project's OWN
   * test suite (repo-checkout mode). The stronger signal: the repo's tests
   * are the oracle, so a surviving mutant is a real coverage gap.
   */
  ownTestsMutation?: MutationResult;
  execution?: ExecutionInfo;
  trustScore: TrustScoreBreakdown;
  costUsd: number;
  latencyMs: number;
  /** Set when this review came from a real GitHub PR (the "Live GitHub" flow), for a clickable link back to it. */
  prUrl?: string;
  prAuthor?: string;
  /** True when analyzed from a real public repo rather than a fixture/simulated diff. */
  isLive?: boolean;
}

export interface BugLocation {
  file: string;
  line: number;
  /** Inclusive end of a multi-line location. */
  endLine?: number;
}

export interface SeededBug {
  id: string;
  description: string;
  /** File-relative locations the bug touches, used to score detection recall. */
  location: BugLocation;
  /** Other places the same bug touches (e.g. every hunk of a multi-hunk fix); a finding at any of them counts. */
  alternateLocations?: BugLocation[];
  category:
    | "off-by-one"
    | "out-of-bounds-index"
    | "removed-null-check"
    | "wrong-operator"
    | "boolean-logic"
    | "type-coercion"
    | "injection"
    | "missing-await"
    | "mutated-return"
    | "swallowed-exception"
    | "division-by-zero"
    | "reverted-fix"
    | "none";
  expectDetection: boolean;
}

export interface BenchmarkCase {
  id: string;
  description: string;
  baseDir: string;
  diffFile: string;
  seededBugs: SeededBug[];
  /** true if this case is a clean/trivial PR that should NOT be flagged (true-negative control). */
  isCleanControl: boolean;
}

export interface BenchmarkCaseResult {
  caseId: string;
  review: ReviewResult;
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: number;
  correctlyLeftClean: boolean;
}

export interface BenchmarkSummary {
  runId: string;
  createdAt: string;
  provider: string;
  cases: BenchmarkCaseResult[];
  /** Which fixture set ran, e.g. "seeded" or a mined real-bug directory. */
  fixtureSet?: string;
  aggregate: {
    precision: number;
    recall: number;
    f1: number;
    totalSeededBugs: number;
    detectedBugs: number;
    falsePositives: number;
    medianLatencyMs: number;
    p95LatencyMs?: number;
    totalCostUsd: number;
    /** Clean-control cases with at least one rule/LLM finding, over all clean controls. */
    cleanFlagRate?: number;
    cleanControls?: number;
  };
  baseline: {
    precision: number;
    recall: number;
    f1: number;
    detectedBugs: number;
    falsePositives: number;
  };
}
