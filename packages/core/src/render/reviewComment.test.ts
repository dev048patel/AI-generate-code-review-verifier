import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../types.js";
import { renderReviewComment } from "./reviewComment.js";

function baseReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    id: "r1",
    repo: "acme/widgets",
    prNumber: 1,
    headSha: "abc",
    createdAt: new Date().toISOString(),
    isTrivial: false,
    trivialReasons: [],
    changedFunctions: [],
    generatedTests: [],
    trustScore: {
      score: 90,
      label: "trusted",
      components: { llmRisk: 90, mutationCoverage: 90, testHealth: 90, ruleFlags: 90 },
      evidence: [],
    },
    costUsd: 0.001,
    latencyMs: 500,
    ...overrides,
  };
}

describe("renderReviewComment", () => {
  it("renders a short trivial-PR comment without scores", () => {
    const body = renderReviewComment(baseReview({ isTrivial: true, trivialReasons: ["docs only"] }));
    expect(body).toContain("docs only");
    expect(body).not.toContain("Mutation-verified");
  });

  it("includes the trust score, label, and component breakdown", () => {
    const body = renderReviewComment(baseReview());
    expect(body).toContain("90/100");
    expect(body).toContain("trusted");
    expect(body).toContain("LLM risk analysis | 90/100");
  });

  it("includes evidence findings when present", () => {
    const body = renderReviewComment(
      baseReview({
        risk: { riskLevel: "high", summary: "risky", intent: "adds a thing", fromFallback: false, findings: [] },
        trustScore: {
          score: 40,
          label: "high-risk",
          components: { llmRisk: 40, mutationCoverage: 40, testHealth: 40, ruleFlags: 40 },
          evidence: [
            { id: "f1", source: "rule", severity: "critical", file: "a.ts", line: 5, title: "SQL injection", detail: "bad" },
          ],
        },
      }),
    );
    expect(body).toContain("SQL injection");
    expect(body).toContain("a.ts:5");
  });

  it("includes mutation score when mutation testing ran", () => {
    const body = renderReviewComment(
      baseReview({
        mutation: {
          mutationScore: 85,
          killed: 17,
          survived: 3,
          timeout: 0,
          noCoverage: 0,
          totalMutants: 20,
          survivedMutants: [],
          durationMs: 100,
        },
        generatedTests: [{ targetFunctionId: "f1", file: "a.test.ts", content: "", kind: "edge-case" }],
      }),
    );
    expect(body).toContain("17/20 mutants killed");
    expect(body).toContain("85% mutation score");
  });
});

describe("sanitization", () => {
  it("neutralizes HTML, mentions, and code-span breakouts in model- or PR-controlled text", () => {
    const body = renderReviewComment(
      baseReview({
        trustScore: {
          score: 40,
          label: "high-risk",
          components: { llmRisk: 40, mutationCoverage: 40, testHealth: 40, ruleFlags: 40 },
          evidence: [
            {
              id: "x",
              source: "llm",
              severity: "high",
              file: "a.ts`<img src=x>",
              line: 3,
              title: "<img src=https://evil/p.png> ping @org/security",
              detail: "</details>\n\n# Approved by #1",
            },
          ],
        },
      }),
    );
    expect(body).not.toContain("<img");
    expect(body).not.toMatch(/@org/);
    expect(body).not.toContain("</details>\n\n# Approved");
    expect(body).toContain("&lt;img");
  });

  it("reports own-test mutation results and execution notes", () => {
    const body = renderReviewComment(
      baseReview({
        ownTestsMutation: { mutationScore: 25, killed: 1, survived: 2, timeout: 0, noCoverage: 1, totalMutants: 4, survivedMutants: [], durationMs: 1 },
        execution: { executor: "local", isolated: false, notes: ["[.] dependency install failed"] },
      }),
    );
    expect(body).toContain("1/4 mutants of the changed lines were caught");
    expect(body).toContain("dependency install failed");
  });
});
