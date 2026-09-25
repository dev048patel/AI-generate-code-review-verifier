import type {
  Finding,
  MutationResult,
  RiskClassification,
  TestRunResult,
  TrustScoreBreakdown,
} from "../types.js";

const SEVERITY_WEIGHT: Record<Finding["severity"], number> = {
  none: 0,
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
};

/**
 * Combines LLM risk classification, mutation-testing results, generated-test
 * health, and rule-based flags into a single 0-100 trust score with the
 * underlying evidence attached, so a reviewer can see *why* the score is
 * what it is rather than trusting a bare number.
 */
export function computeTrustScore(input: {
  risk?: RiskClassification;
  mutation?: MutationResult;
  /** Changed lines mutated against the project's own tests; takes precedence over `mutation` when present. */
  ownTestsMutation?: MutationResult;
  testRun?: TestRunResult;
  ruleFindings: Finding[];
  /**
   * True for a trivial PR (docs/config/whitespace-only) where there is no
   * code to generate tests for or mutate. Missing mutation/test data then
   * means "not applicable", not "unknown" -- the opposite of a non-trivial
   * PR where missing data means analysis was skipped or failed and should
   * be treated cautiously (a neutral, not perfect, default).
   */
  isTrivial?: boolean;
}): TrustScoreBreakdown {
  const { risk, mutation, ownTestsMutation, testRun, ruleFindings, isTrivial = false } = input;

  // 1. LLM/rule risk component (100 = no risk found, penalized by severity).
  //    No LLM ran on a non-trivial PR (none configured): unknown, not "no risk".
  const riskFindings = risk?.findings ?? [];
  const riskPenalty = riskFindings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const assessed = risk !== undefined && !risk.skipped;
  const llmRisk = assessed || isTrivial ? clamp(100 - riskPenalty, 0, 100) : 50;

  // 2. Mutation coverage component: directly the mutation score. When it
  //    didn't run, that's either "not applicable" (trivial PR: 100) or
  //    "unknown, be cautious" (non-trivial PR where it was skipped/failed: 50).
  //    The project's own suite is the better oracle, so its score wins when both exist.
  const bestMutation = ownTestsMutation ?? mutation;
  const mutationCoverage = bestMutation ? clamp(bestMutation.mutationScore, 0, 100) : isTrivial ? 100 : 50;

  // 3. Test health: passing generated tests raise confidence; failures (which
  //    may indicate the generated test caught a real bug) lower it sharply.
  let testHealth = isTrivial ? 100 : 70; // neutral-ish default when no tests were generated/run
  if (testRun) {
    if (testRun.total === 0) {
      testHealth = 50;
    } else {
      const passRate = testRun.passed / testRun.total;
      testHealth = clamp(Math.round(passRate * 100), 0, 100);
    }
  }

  // 4. Rule-flag component: independent of the LLM, penalize deterministic findings.
  const rulePenalty = ruleFindings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const ruleFlags = clamp(100 - rulePenalty, 0, 100);

  const score = Math.round(
    llmRisk * 0.35 + mutationCoverage * 0.3 + testHealth * 0.2 + ruleFlags * 0.15,
  );

  const label: TrustScoreBreakdown["label"] =
    score >= 80 ? "trusted" : score >= 50 ? "needs-review" : "high-risk";

  const evidence = dedupeFindings([
    ...riskFindings,
    ...ruleFindings,
    ...ownTestMutantsAsFindings(ownTestsMutation),
    ...mutantsAsFindings(mutation),
  ]);

  return {
    score,
    label,
    components: { llmRisk, mutationCoverage, testHealth, ruleFlags },
    evidence,
  };
}

function mutantsAsFindings(mutation?: MutationResult): Finding[] {
  if (!mutation) return [];
  return mutation.survivedMutants.slice(0, 10).map((m, i) => ({
    id: `mutant-${m.id}-${i}`,
    source: "mutation" as const,
    severity: "medium" as const,
    file: m.file,
    line: m.line,
    title: `Surviving mutant: ${m.mutatorName}`,
    detail:
      "Generated tests did not fail when this line was mutated, meaning the tests don't actually constrain this behavior.",
    evidence: `original: ${m.originalCode}\nmutated: ${m.mutatedCode}`,
  }));
}

function ownTestMutantsAsFindings(mutation?: MutationResult): Finding[] {
  if (!mutation) return [];
  return mutation.survivedMutants.slice(0, 15).map((m, i) => {
    const uncovered = m.status === "NoCoverage";
    return {
      id: `own-mutant-${m.id}-${i}`,
      source: "mutation" as const,
      severity: "medium" as const,
      file: m.file,
      line: m.line,
      title: uncovered ? "Changed code is not executed by any test" : `Existing tests miss this change (${m.mutatorName})`,
      detail: uncovered
        ? "No test in the project's own suite runs this changed line, so any behavior here is unverified."
        : "The project's own test suite still passes when this changed line is mutated, so the tests don't pin down its behavior.",
      evidence: `original: ${m.originalCode}\nmutated: ${m.mutatedCode}`,
    };
  });
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.source}:${f.file}:${f.line ?? "-"}:${f.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
