// Mirrors the wire shape of @acrv/core's types, kept as a plain local copy so
// the dashboard never imports server-side code (e.g. the SQLite store) into
// the browser bundle.

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type FindingSource = "rule" | "llm" | "mutation" | "test";

export interface Finding {
  id: string;
  source: FindingSource;
  severity: RiskLevel;
  file: string;
  line?: number;
  title: string;
  detail: string;
  evidence?: string;
}

export interface RiskClassification {
  riskLevel: RiskLevel;
  summary: string;
  intent: string;
  findings: Finding[];
  fromFallback: boolean;
  modelId?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
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

export interface SurvivedMutant {
  id: string;
  file: string;
  line: number;
  mutatorName: string;
  originalCode: string;
  mutatedCode: string;
}

export interface MutationResult {
  mutationScore: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  totalMutants: number;
  survivedMutants: SurvivedMutant[];
  durationMs: number;
}

export interface ChangedFunction {
  id: string;
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  sourceText: string;
  isAsync: boolean;
  isExported: boolean;
}

export interface TrustScoreBreakdown {
  score: number;
  label: "trusted" | "needs-review" | "high-risk";
  components: {
    llmRisk: number;
    mutationCoverage: number;
    testHealth: number;
    ruleFlags: number;
  };
  evidence: Finding[];
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
  mutation?: MutationResult;
  execution?: { executor: "local" | "docker" | "none"; isolated: boolean; skippedReason?: string };
  trustScore: TrustScoreBreakdown;
  costUsd: number;
  latencyMs: number;
  prUrl?: string;
  prAuthor?: string;
  isLive?: boolean;
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
  provider: "bedrock" | "mock";
  cases: BenchmarkCaseResult[];
  aggregate: {
    precision: number;
    recall: number;
    f1: number;
    totalSeededBugs: number;
    detectedBugs: number;
    falsePositives: number;
    medianLatencyMs: number;
    totalCostUsd: number;
  };
  baseline: {
    precision: number;
    recall: number;
    f1: number;
    detectedBugs: number;
    falsePositives: number;
  };
}

export interface FixtureSummary {
  id: string;
  prTitle: string;
  isCleanControl: boolean;
  categories: string[];
}

export interface OpenPullRequestSummary {
  number: number;
  title: string;
  authorLogin: string;
  updatedAt: string;
  htmlUrl: string;
}
