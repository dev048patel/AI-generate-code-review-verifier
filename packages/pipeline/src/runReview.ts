import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeTrustScore, type ChangedFunction, type GeneratedTestFile, type ReviewResult } from "@acrv/core";
import { reviewCostUsd, type LLMProvider } from "@acrv/llm";
import { LocalProcessExecutor, runGeneratedTests, runMutation, type SandboxExecutor } from "@acrv/mutation";
import { analyzeDiff, generateTests, newReview, UNTRUSTED_SKIP_REASON } from "./analysis.js";

export interface RunReviewInput {
  repo: string;
  prNumber: number;
  headSha: string;
  prTitle: string;
  prDescription: string;
  /** Unified diff text, e.g. from `git diff` or the GitHub compare API. */
  diffText: string;
  /** Full "after" content of every file touched by the diff, keyed by its diff path. */
  afterFileContents: Record<string, string>;
  llmProvider: LLMProvider;
  /**
   * Absolute directory (must live under this repo's root -- see
   * @acrv/mutation's sandboxSetup) under which a unique per-review sandbox
   * subdirectory will be created and cleaned up.
   */
  sandboxRoot: string;
  /** Skip mutation testing (still runs generated tests) -- useful for very large diffs or quick iteration. */
  skipMutation?: boolean;
  /** Keep the sandbox directory after the review for inspection/debugging. */
  keepSandbox?: boolean;
  /** Link back to the real PR, when this review came from a live GitHub fetch. */
  prUrl?: string;
  prAuthor?: string;
  isLive?: boolean;
  /**
   * Where generated tests and mutants execute. Defaults to a local child
   * process, which is only acceptable for trusted code (fixtures, this
   * repo's own tests).
   */
  executor?: SandboxExecutor;
  /**
   * True when the PR's code comes from someone outside the reviewer's trust
   * boundary (any real PR, any pasted diff). Untrusted code is only executed
   * by an executor that allows it; otherwise execution is skipped and the
   * review says so, rather than running attacker code next to credentials.
   */
  untrusted?: boolean;
}

/**
 * Runs the full review pipeline for one PR: diff parsing, the rule-based
 * trivial-PR fallback, LLM risk classification (skipped for trivial PRs),
 * test generation, sandboxed test execution, mutation testing, and the
 * final trust-score computation. This is the single entry point shared by
 * the GitHub webhook server and the evaluation harness, so both exercise
 * identical logic.
 */
export async function runReview(input: RunReviewInput): Promise<ReviewResult> {
  const start = Date.now();
  const analysis = analyzeDiff(input.diffText, input.afterFileContents);
  const { parsed, trivial, ruleFindings, changedFunctions } = analysis;
  const review = newReview(input, analysis);

  if (trivial.isTrivial) {
    review.latencyMs = Date.now() - start;
    return review;
  }

  review.risk = await input.llmProvider.classify({
    repo: input.repo,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
    files: parsed.files,
    changedFunctions,
  });
  review.costUsd = reviewCostUsd(review.risk);

  const { testableFunctions, generatedTests } = generateTests(changedFunctions);
  review.generatedTests = generatedTests;

  const executor = input.executor ?? new LocalProcessExecutor();
  const skippedReason = input.untrusted && !executor.allowsUntrustedCode ? UNTRUSTED_SKIP_REASON : undefined;
  review.execution = { executor: executor.kind, isolated: executor.isolated, skippedReason };

  if (generatedTests.length > 0 && !skippedReason) {
    const sandboxDir = path.join(input.sandboxRoot, `review-${review.id}`);
    try {
      const mutateGlobs = await writeSandbox(sandboxDir, testableFunctions, generatedTests, input.afterFileContents);

      review.testRun = await runGeneratedTests({ sandboxDir, executor });
      // Stryker requires a fully-passing baseline before it will mutate:
      // a generated test already failing against the unmutated code is
      // itself the signal (often the seeded/real bug surfacing directly),
      // and mutation testing has nothing meaningful to add on top of it.
      if (!input.skipMutation && review.testRun.failed === 0 && review.testRun.total > 0) {
        review.mutation = await runMutation({ sandboxDir, mutateGlobs, executor });
      }
    } finally {
      if (!input.keepSandbox) {
        await rm(sandboxDir, { recursive: true, force: true });
      }
    }
  }

  review.trustScore = computeTrustScore({
    risk: review.risk,
    mutation: review.mutation,
    testRun: review.testRun,
    ruleFindings,
  });
  review.latencyMs = Date.now() - start;
  return review;
}

/**
 * Mirrors the changed files and generated tests into the sandbox at their
 * repo-relative paths (so same-named files in different directories don't
 * collide and relative imports between changed files still resolve).
 */
async function writeSandbox(
  sandboxDir: string,
  testableFunctions: ChangedFunction[],
  generatedTests: GeneratedTestFile[],
  afterFileContents: Record<string, string>,
): Promise<string[]> {
  await mkdir(sandboxDir, { recursive: true });

  const uniqueSourceFiles = [...new Set(testableFunctions.map((fn) => fn.file))];
  for (const file of uniqueSourceFiles) {
    const content = afterFileContents[file];
    if (content === undefined) continue;
    await writeInside(sandboxDir, file, content);
  }

  for (const test of generatedTests) {
    await writeInside(sandboxDir, test.file, test.content);
  }

  return uniqueSourceFiles.map((f) => toPosix(safeRelative(f)));
}

/** Rejects absolute paths and `..` segments: file names come from the PR and are attacker-controlled. */
export function safeRelative(file: string): string {
  const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Refusing unsafe path from diff: ${file}`);
  }
  return normalized;
}

async function writeInside(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, safeRelative(file));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
