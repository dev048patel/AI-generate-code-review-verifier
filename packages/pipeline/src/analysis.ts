import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  checkTrivial,
  computeTrustScore,
  extractChangedFunctions,
  parseDiff,
  runStaticAnalysis,
  type ChangedFunction,
  type Finding,
  type GeneratedTestFile,
  type ParsedDiff,
  type ReviewResult,
  type TrivialCheckResult,
} from "@acrv/core";
import { generateTestsForFunction } from "@acrv/test-generator";

export interface DiffAnalysis {
  parsed: ParsedDiff;
  trivial: TrivialCheckResult;
  ruleFindings: Finding[];
  changedFunctions: ChangedFunction[];
}

/** The deterministic, no-execution part of every review: diff parsing, rules, and changed-function extraction. */
export function analyzeDiff(diffText: string, afterFileContents: Record<string, string>): DiffAnalysis {
  const parsed = parseDiff(diffText);
  const trivial = checkTrivial(parsed);
  const ruleFindings = parsed.files.flatMap((f) => runStaticAnalysis(f));

  let changedFunctions: ChangedFunction[] = [];
  for (const file of parsed.files) {
    const content = afterFileContents[file.newPath];
    if (!content || file.isBinary || file.isDeleted) continue;
    changedFunctions = changedFunctions.concat(extractChangedFunctions(file.newPath, content, file.changedLines));
  }
  return { parsed, trivial, ruleFindings, changedFunctions };
}

export interface ReviewMeta {
  repo: string;
  prNumber: number;
  headSha: string;
  prUrl?: string;
  prAuthor?: string;
  isLive?: boolean;
}

export function newReview(meta: ReviewMeta, analysis: DiffAnalysis): ReviewResult {
  return {
    id: randomUUID(),
    repo: meta.repo,
    prNumber: meta.prNumber,
    headSha: meta.headSha,
    createdAt: new Date().toISOString(),
    isTrivial: analysis.trivial.isTrivial,
    trivialReasons: analysis.trivial.reasons,
    changedFunctions: analysis.changedFunctions,
    generatedTests: [],
    trustScore: computeTrustScore({ ruleFindings: analysis.ruleFindings, isTrivial: analysis.trivial.isTrivial }),
    costUsd: 0,
    latencyMs: 0,
    prUrl: meta.prUrl,
    prAuthor: meta.prAuthor,
    isLive: meta.isLive,
  };
}

/** Generated edge-case/property tests for every exported changed function, each placed next to its source file. */
export function generateTests(changedFunctions: ChangedFunction[]): {
  testableFunctions: ChangedFunction[];
  generatedTests: GeneratedTestFile[];
} {
  const testableFunctions = changedFunctions.filter((fn) => fn.isExported);
  let generatedTests: GeneratedTestFile[] = [];
  for (const fn of testableFunctions) {
    const importSpecifier = "./" + path.basename(fn.file).replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
    generatedTests = generatedTests.concat(generateTestsForFunction(fn, { importSpecifier }));
  }
  return { testableFunctions, generatedTests };
}

export const UNTRUSTED_SKIP_REASON =
  "Untrusted PR code was not executed: no isolated sandbox is configured (set ACRV_SANDBOX=docker).";
