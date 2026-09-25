import type { ParsedDiff, TrivialCheckResult } from "../types.js";
import { isDocsOrConfigOnly } from "../diff/parseDiff.js";

const TRIVIAL_LINE_RE = /^[+-]\s*(\/\/.*|\*.*|\/\*.*|import .*|export \* from .*)?\s*$/;

/**
 * Deterministic, zero-cost check for whether a PR is trivial enough that an
 * LLM call would be wasted: docs/lockfile-only changes, whitespace/comment-only
 * diffs, or pure import reordering. This is the "rule-based fallback" so the
 * LLM is only invoked where a deterministic check can't already decide.
 */
export function checkTrivial(diff: ParsedDiff): TrivialCheckResult {
  if (diff.files.length === 0) {
    return { isTrivial: true, reasons: ["empty diff"] };
  }

  const reasons: string[] = [];
  let allTrivial = true;

  for (const file of diff.files) {
    if (file.isBinary) {
      reasons.push(`${file.newPath}: binary file, no reviewable source change`);
      continue;
    }
    if (isDocsOrConfigOnly(file)) {
      reasons.push(`${file.newPath}: docs/lockfile-only change`);
      continue;
    }

    const codeLines = file.hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+") || l.startsWith("-"))
      .filter((l) => !l.startsWith("+++") && !l.startsWith("---"));

    const nonTrivialLines = codeLines.filter((l) => !TRIVIAL_LINE_RE.test(l));

    if (nonTrivialLines.length === 0) {
      reasons.push(`${file.newPath}: whitespace/comment/import-only change`);
      continue;
    }

    allTrivial = false;
  }

  return { isTrivial: allTrivial, reasons };
}
