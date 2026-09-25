import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MockProvider } from "@acrv/llm";
import { runBenchmark } from "./runBenchmark.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

beforeAll(async () => {
  await mkdir(path.join(repoRoot, "sandbox-runs"), { recursive: true });
});

describe("runBenchmark", () => {
  it("detects a seeded bug and reports it as a true positive with no false positives", async () => {
    const summary = await runBenchmark({
      llmProvider: new MockProvider(),
      skipMutation: true,
      only: ["wrong-operator-modified"],
    });
    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]!.truePositives).toEqual(["wrong-operator-modified-1"]);
    expect(summary.cases[0]!.falsePositives).toBe(0);
    expect(summary.aggregate.recall).toBe(1);
  }, 30_000);

  it("leaves a clean control case clean with no false positives", async () => {
    const summary = await runBenchmark({
      llmProvider: new MockProvider(),
      skipMutation: true,
      only: ["clean-safe-newcode"],
    });
    expect(summary.cases[0]!.correctlyLeftClean).toBe(true);
    expect(summary.cases[0]!.falsePositives).toBe(0);
  }, 30_000);

  it("computes a baseline strictly weaker than or equal to the full pipeline on new-code bugs", async () => {
    // out-of-bounds-index-newcode requires whole-function reasoning
    // (functionHeuristics), which the no-AI baseline deliberately excludes.
    const summary = await runBenchmark({
      llmProvider: new MockProvider(),
      skipMutation: true,
      only: ["out-of-bounds-index-newcode"],
    });
    expect(summary.aggregate.detectedBugs).toBe(1);
    expect(summary.baseline.detectedBugs).toBe(0);
  }, 30_000);

  it("skips the trivial docs-only case without invoking the LLM", async () => {
    const summary = await runBenchmark({
      llmProvider: new MockProvider(),
      skipMutation: true,
      only: ["clean-docs-only"],
    });
    expect(summary.cases[0]!.review.isTrivial).toBe(true);
    expect(summary.cases[0]!.review.risk).toBeUndefined();
  }, 30_000);
});
