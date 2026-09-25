import {
  runFunctionHeuristics,
  runStaticAnalysis,
  type Finding,
  type RiskClassification,
  type RiskLevel,
} from "@acrv/core";
import type { LLMProvider, RiskClassificationRequest } from "./LLMProvider.js";

const SEVERITY_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/**
 * Deterministic heuristic engine standing in for a real LLM call. Used for
 * local development, unit tests, and as the evaluation-harness provider when
 * `LLM_PROVIDER=mock` (the default when no AWS credentials are configured),
 * so the whole pipeline is runnable and testable without Bedrock access.
 *
 * It combines the line-diff static rules (same ones used by the no-AI
 * baseline) with whole-function AST heuristics that a plain linter would not
 * perform, approximating the "extra" value a real LLM review adds. It is
 * intentionally not as capable as a real model — see docs/evaluation.md for
 * the honest gap between mock and Bedrock recall on the seeded-bug benchmark.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async classify(request: RiskClassificationRequest): Promise<RiskClassification> {
    const start = Date.now();

    const ruleFindings = request.files.flatMap((f) => runStaticAnalysis(f));
    const fnFindings = request.changedFunctions.flatMap((fn) => runFunctionHeuristics(fn));
    const findings: Finding[] = [
      ...ruleFindings.map((f) => ({ ...f, source: "llm" as const, id: `mock-${f.id}` })),
      ...fnFindings,
    ];

    const riskLevel = findings.reduce<RiskLevel>((max, f) => {
      return SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(max) ? f.severity : max;
    }, "none");

    const intent = summarizeIntent(request);
    const summary = summarize(findings, intent);

    // Simulate realistic (small) latency so latency dashboards have non-zero data locally.
    const simulatedLatencyMs = 150 + Math.min(850, request.files.length * 60 + findings.length * 25);
    await sleep(0); // keep async contract without actually blocking tests

    return {
      riskLevel,
      summary,
      intent,
      findings,
      fromFallback: false,
      modelId: "mock-heuristic-v1",
      latencyMs: Date.now() - start + simulatedLatencyMs,
      inputTokens: estimateTokens(request),
      outputTokens: Math.round(summary.length / 4),
    };
  }
}

function summarizeIntent(request: RiskClassificationRequest): string {
  const fileList = request.files.map((f) => f.newPath).join(", ");
  return request.prTitle || `Modifies ${fileList}`;
}

function summarize(findings: Finding[], intent: string): string {
  if (findings.length === 0) {
    return `${intent}. No correctness, security, or edge-case risks were detected by static and heuristic analysis.`;
  }
  const bySeverity = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(bySeverity)
    .map(([sev, count]) => `${count} ${sev}`)
    .join(", ");
  return `${intent}. Found ${findings.length} potential issue(s) (${parts}). Top concern: ${findings[0]?.title}.`;
}

function estimateTokens(request: RiskClassificationRequest): number {
  const chars = request.files.reduce(
    (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.join("\n").length, 0),
    0,
  );
  return Math.round(chars / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
