import type { ReviewResult } from "../types.js";

const LABEL_EMOJI: Record<ReviewResult["trustScore"]["label"], string> = {
  trusted: "✅",
  "needs-review": "⚠️",
  "high-risk": "🚨",
};

const MAX_FIELD = 600;

/**
 * Neutralizes text that came from an LLM or from an execution phase that ran
 * PR code before it goes into a GitHub comment: no raw HTML (images, hidden
 * tags, fake <details>), no @-mentions or #-references that ping people or
 * cross-link issues, no line breaks that start new Markdown blocks.
 */
export function sanitizeInline(text: string, max = MAX_FIELD): string {
  const oneLine = text.replace(/[\r\n]+/g, " ").trim();
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return clipped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=\w)/g, "@​")
    .replace(/#(?=\d)/g, "#​")
    .replace(/([\\`*_[\]|])/g, "\\$1");
}

/** For code-ish values shown inside backticks: strip backticks so they can't close the span. */
export function sanitizeCode(text: string, max = 200): string {
  const oneLine = text.replace(/[\r\n]+/g, " ").replace(/`/g, "'").replace(/[<>]/g, "").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Renders a review as the Markdown body of a GitHub PR comment / job summary: the "trust score with evidence". */
export function renderReviewComment(review: ReviewResult): string {
  const { trustScore } = review;
  const lines: string[] = [];

  lines.push(`### ${LABEL_EMOJI[trustScore.label]} AI Code Review Verifier — Trust Score: ${trustScore.score}/100 (${trustScore.label})`);
  lines.push("");

  if (review.isTrivial) {
    lines.push(`This PR looks trivial (${sanitizeInline(review.trivialReasons.join("; "))}) — skipped LLM analysis.`);
    lines.push("");
    return lines.join("\n");
  }

  if (review.risk) {
    lines.push(`**Intent:** ${sanitizeInline(review.risk.intent)}`);
    lines.push("");
    lines.push(sanitizeInline(review.risk.summary, 1500));
    lines.push("");
  }

  if (review.execution?.skippedReason) {
    lines.push(`> 🔒 ${sanitizeInline(review.execution.skippedReason)} Test and mutation scores are neutral placeholders, not evidence.`);
    lines.push("");
  }

  lines.push(`| Signal | Score |`);
  lines.push(`| --- | --- |`);
  lines.push(`| LLM risk analysis | ${trustScore.components.llmRisk}/100 |`);
  lines.push(`| Mutation-verified test coverage | ${trustScore.components.mutationCoverage}/100 |`);
  lines.push(`| Generated-test health | ${trustScore.components.testHealth}/100 |`);
  lines.push(`| Deterministic rule checks | ${trustScore.components.ruleFlags}/100 |`);
  lines.push("");

  if (review.ownTestsMutation) {
    const m = review.ownTestsMutation;
    lines.push(
      `**Your tests vs. this change:** ${m.killed + m.timeout}/${m.totalMutants} mutants of the changed lines were caught by the project's own test suite (${m.mutationScore}%). ` +
        `${m.noCoverage} changed-line mutant(s) aren't executed by any test.`,
    );
    lines.push("");
  }

  if (trustScore.evidence.length > 0) {
    lines.push(`<details><summary>Evidence (${trustScore.evidence.length} finding(s))</summary>`);
    lines.push("");
    for (const finding of trustScore.evidence) {
      const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(
        `- **[${finding.severity}] ${sanitizeInline(finding.title, 200)}** (\`${sanitizeCode(loc)}\`) — ${sanitizeInline(finding.detail)}`,
      );
    }
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  if (review.mutation) {
    lines.push(
      `Mutation testing: ${review.mutation.killed}/${review.mutation.totalMutants} mutants killed (${review.mutation.mutationScore}% mutation score) across ${review.generatedTests.length} generated test(s).`,
    );
    lines.push("");
  }

  const notes = review.execution?.notes ?? [];
  if (notes.length > 0) {
    lines.push(`<details><summary>Execution notes (${notes.length})</summary>`);
    lines.push("");
    for (const note of notes.slice(0, 20)) lines.push(`- ${sanitizeInline(note, 300)}`);
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  lines.push(`_Review took ${review.latencyMs}ms and cost ~$${review.costUsd.toFixed(4)}._`);

  return lines.join("\n");
}
