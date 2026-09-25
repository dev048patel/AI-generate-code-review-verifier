import { describe, expect, it } from "vitest";
import { computeTrustScore } from "./computeTrustScore.js";
import type { Finding, MutationResult, RiskClassification, TestRunResult } from "../types.js";

describe("computeTrustScore", () => {
  it("gives a high score when the LLM ran and everything is clean", () => {
    const risk: RiskClassification = { riskLevel: "none", summary: "", intent: "", findings: [], fromFallback: false };
    const result = computeTrustScore({ risk, ruleFindings: [] });
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("treats a missing LLM analysis on a non-trivial PR as unknown, not as clean", () => {
    const result = computeTrustScore({ ruleFindings: [] });
    expect(result.components.llmRisk).toBe(50);
    expect(result.label).not.toBe("trusted");
    expect(computeTrustScore({ ruleFindings: [], isTrivial: true }).components.llmRisk).toBe(100);
  });

  it("penalizes critical LLM findings heavily", () => {
    const risk: RiskClassification = {
      riskLevel: "critical",
      summary: "SQL injection risk",
      intent: "adds a query endpoint",
      fromFallback: false,
      findings: [
        {
          id: "1",
          source: "llm",
          severity: "critical",
          file: "a.ts",
          title: "SQL injection",
          detail: "unsafe concat",
        } satisfies Finding,
      ],
    };
    const result = computeTrustScore({ risk, ruleFindings: [] });
    expect(result.label).not.toBe("trusted");
    expect(result.components.llmRisk).toBeLessThanOrEqual(50);
  });

  it("lowers score when mutation score is low (weak tests)", () => {
    const mutation: MutationResult = {
      mutationScore: 10,
      killed: 1,
      survived: 9,
      timeout: 0,
      noCoverage: 0,
      totalMutants: 10,
      survivedMutants: [],
      durationMs: 100,
    };
    const clean = computeTrustScore({ ruleFindings: [] });
    const weak = computeTrustScore({ ruleFindings: [], mutation });
    expect(weak.score).toBeLessThan(clean.score);
  });

  it("lowers test health when generated tests fail", () => {
    const testRun: TestRunResult = {
      passed: 1,
      failed: 9,
      total: 10,
      durationMs: 500,
      failures: [{ testName: "edge case 1", message: "expected 2 got 3" }],
    };
    const result = computeTrustScore({ ruleFindings: [], testRun });
    expect(result.components.testHealth).toBeLessThanOrEqual(20);
  });

  it("includes survived mutants and findings in evidence, deduplicated", () => {
    const finding: Finding = {
      id: "dup1",
      source: "rule",
      severity: "medium",
      file: "a.ts",
      line: 5,
      title: "dup",
      detail: "same",
    };
    const result = computeTrustScore({ ruleFindings: [finding, { ...finding, id: "dup2" }] });
    expect(result.evidence).toHaveLength(1);
  });

  it("labels a score below 50 as high-risk and above 80 as trusted", () => {
    const criticalFindings = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`,
      source: "rule" as const,
      severity: "critical" as const,
      file: "a.ts",
      title: `finding ${i}`,
      detail: "bad",
    }));
    const highRisk = computeTrustScore({
      ruleFindings: criticalFindings,
      risk: {
        riskLevel: "critical",
        summary: "multiple critical issues",
        intent: "adds a feature",
        fromFallback: false,
        findings: criticalFindings.map((f) => ({ ...f, source: "llm" as const })),
      },
    });
    expect(highRisk.label).toBe("high-risk");

    const trusted = computeTrustScore({
      ruleFindings: [],
      mutation: {
        mutationScore: 95,
        killed: 19,
        survived: 1,
        timeout: 0,
        noCoverage: 0,
        totalMutants: 20,
        survivedMutants: [],
        durationMs: 100,
      },
      testRun: { passed: 10, failed: 0, total: 10, durationMs: 100, failures: [] },
    });
    expect(trusted.label).toBe("trusted");
  });
});
