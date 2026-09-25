import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff, runStaticAnalysis, type BenchmarkCaseResult, type BenchmarkSummary, type Finding } from "@acrv/core";
import { createLLMProvider, type LLMProvider, type ProviderName } from "@acrv/llm";
import { runReview } from "@acrv/pipeline";
import { buildDiffFromFiles } from "./buildDiffFromFiles.js";
import { FIXTURES_DIR, loadFixtures, readFixtureFileContents } from "./loadFixtures.js";
import { matchFindings } from "./matchFindings.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const sandboxRoot = path.join(repoRoot, "sandbox-runs");

export interface RunBenchmarkOptions {
  provider?: ProviderName;
  /** Override the LLM provider directly (e.g. from a test double). */
  llmProvider?: LLMProvider;
  skipMutation?: boolean;
  /** Restrict the run to specific fixture ids, for fast iteration. */
  only?: string[];
  /** Fixture directory: the seeded set by default, or a mined real-bug set. */
  fixturesDir?: string;
  /** Run at most this many fixtures. */
  limit?: number;
  /** Stop starting new fixtures once spend reaches this (real providers bill per call). */
  maxCostUsd?: number;
  onProgress?: (done: number, total: number, costUsd: number) => void;
}

/**
 * Runs the full review pipeline against every seeded-bug fixture and
 * computes precision/recall/F1 for (a) the full pipeline (LLM + rules +
 * mutation) and (b) a "no-AI" baseline that only runs the deterministic
 * line-diff static-analysis rules. This is the evaluation harness described
 * in the project brief: the measured proof of how far to trust the bot's
 * own output.
 */
export async function runBenchmark(options: RunBenchmarkOptions = {}): Promise<BenchmarkSummary> {
  await mkdir(sandboxRoot, { recursive: true });
  const providerName = options.provider ?? "mock";
  const llmProvider = options.llmProvider ?? createLLMProvider({ provider: providerName });

  const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
  let fixtures = await loadFixtures(fixturesDir);
  if (options.only) {
    const wanted = new Set(options.only);
    fixtures = fixtures.filter((f) => wanted.has(f.id));
  }
  if (options.limit !== undefined) fixtures = fixtures.slice(0, options.limit);

  const caseResults: BenchmarkCaseResult[] = [];
  const baselineTallies = { tp: 0, fp: 0 };
  let totalSeededBugs = 0;
  let detectedBugs = 0;
  let totalFalsePositives = 0;
  const latencies: number[] = [];
  let totalCost = 0;

  let cleanControls = 0;
  let cleanFlagged = 0;

  for (const fixture of fixtures) {
    if (options.maxCostUsd !== undefined && totalCost >= options.maxCostUsd) {
      console.warn(`[eval] stopping early: spend $${totalCost.toFixed(2)} reached the $${options.maxCostUsd} cap`);
      break;
    }
    const { before, after } = await readFixtureFileContents(fixture);
    const changes = fixture.meta.files.map((f) => ({ path: f, before: before[f] ?? null, after: after[f] ?? null }));
    const diffText = buildDiffFromFiles(changes);

    const afterFileContents: Record<string, string> = {};
    for (const f of fixture.meta.files) {
      if (after[f] !== null) afterFileContents[f] = after[f] as string;
    }

    const review = await runReview({
      repo: "eval-harness/fixtures",
      prNumber: 0,
      headSha: fixture.id,
      prTitle: fixture.meta.prTitle,
      prDescription: fixture.meta.prDescription,
      diffText,
      afterFileContents,
      llmProvider,
      sandboxRoot,
      skipMutation: options.skipMutation,
    });

    latencies.push(review.latencyMs);
    totalCost += review.costUsd;

    const match = matchFindings(fixture.meta.seededBugs, review.trustScore.evidence, fixture.meta.isCleanControl);

    caseResults.push({
      caseId: fixture.id,
      review,
      truePositives: match.truePositives,
      falseNegatives: match.falseNegatives,
      falsePositives: match.falsePositives,
      correctlyLeftClean: match.correctlyLeftClean,
    });

    const expectedCount = fixture.meta.seededBugs.filter((b) => b.expectDetection).length;
    totalSeededBugs += expectedCount;
    detectedBugs += match.truePositives.length;
    totalFalsePositives += match.falsePositives;
    if (fixture.meta.isCleanControl) {
      cleanControls++;
      if (!match.correctlyLeftClean) cleanFlagged++;
    }
    options.onProgress?.(caseResults.length, fixtures.length, totalCost);

    // No-AI baseline: only the deterministic line-diff static rules, no LLM
    // and no whole-function heuristics (those require AST-level reasoning a
    // plain linter wouldn't do).
    const parsed = parseDiff(diffText);
    const baselineFindings: Finding[] = parsed.files.flatMap((f) => runStaticAnalysis(f));
    const baselineMatch = matchFindings(fixture.meta.seededBugs, baselineFindings, fixture.meta.isCleanControl);
    baselineTallies.tp += baselineMatch.truePositives.length;
    baselineTallies.fp += baselineMatch.falsePositives;
  }

  const precision = safeDiv(detectedBugs, detectedBugs + totalFalsePositives);
  const recall = safeDiv(detectedBugs, totalSeededBugs);
  const f1 = safeDiv(2 * precision * recall, precision + recall);

  const baselinePrecision = safeDiv(baselineTallies.tp, baselineTallies.tp + baselineTallies.fp);
  const baselineRecall = safeDiv(baselineTallies.tp, totalSeededBugs);
  const baselineF1 = safeDiv(2 * baselinePrecision * baselineRecall, baselinePrecision + baselineRecall);

  return {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    createdAt: new Date().toISOString(),
    provider: llmProvider.name,
    fixtureSet: fixturesDir === FIXTURES_DIR ? "seeded" : path.basename(fixturesDir),
    cases: caseResults,
    aggregate: {
      precision,
      recall,
      f1,
      totalSeededBugs,
      detectedBugs,
      falsePositives: totalFalsePositives,
      medianLatencyMs: median(latencies),
      p95LatencyMs: percentile(latencies, 0.95),
      totalCostUsd: totalCost,
      cleanFlagRate: cleanControls === 0 ? 0 : cleanFlagged / cleanControls,
      cleanControls,
    },
    baseline: {
      precision: baselinePrecision,
      recall: baselineRecall,
      f1: baselineF1,
      detectedBugs: baselineTallies.tp,
      falsePositives: baselineTallies.fp,
    },
  };
}

function safeDiv(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 1 : 0;
  return numerator / denominator;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}
