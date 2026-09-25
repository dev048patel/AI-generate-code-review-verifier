import type { Finding, SeededBug } from "@acrv/core";

export interface MatchResult {
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: number;
  correctlyLeftClean: boolean;
}

/** Findings within this many lines of a seeded bug's location count as detecting it. */
const MATCH_LINE_TOLERANCE = 3;

/**
 * Matches a review's findings against a fixture's seeded bugs by file+line
 * proximity. Any finding that lands near an expected bug counts toward
 * detecting it (multiple overlapping findings about the same real bug are
 * not double-penalized); a finding that doesn't correspond to any expected
 * bug counts as a false positive.
 */
export function matchFindings(seededBugs: SeededBug[], findings: Finding[], isCleanControl: boolean): MatchResult {
  // Only rule- and llm-sourced findings represent "bug claims"; mutation
  // survivor findings are a test-quality signal, not a correctness claim,
  // so they're excluded from precision/recall bookkeeping.
  const relevant = findings.filter((f) => f.source === "rule" || f.source === "llm");
  const expectedBugs = seededBugs.filter((b) => b.expectDetection);

  const detectedBugIds = new Set<string>();
  let matchedFindingCount = 0;

  for (const finding of relevant) {
    const matchedBug = expectedBugs.find((bug) =>
      [bug.location, ...(bug.alternateLocations ?? [])].some(
        (loc) =>
          loc.file === finding.file &&
          finding.line !== undefined &&
          finding.line >= loc.line - MATCH_LINE_TOLERANCE &&
          finding.line <= (loc.endLine ?? loc.line) + MATCH_LINE_TOLERANCE,
      ),
    );
    if (matchedBug) {
      detectedBugIds.add(matchedBug.id);
      matchedFindingCount++;
    }
  }

  const truePositives = [...detectedBugIds];
  const falseNegatives = expectedBugs.filter((b) => !detectedBugIds.has(b.id)).map((b) => b.id);
  const falsePositives = relevant.length - matchedFindingCount;
  const correctlyLeftClean = isCleanControl ? relevant.length === 0 : true;

  return { truePositives, falseNegatives, falsePositives, correctlyLeftClean };
}
