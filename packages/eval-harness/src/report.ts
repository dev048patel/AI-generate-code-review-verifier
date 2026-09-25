import type { BenchmarkSummary } from "@acrv/core";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Renders a BenchmarkSummary as a human-readable Markdown report. */
export function renderMarkdownReport(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push(`# Evaluation Report`);
  lines.push("");
  lines.push(`Run: \`${summary.runId}\`  `);
  lines.push(`Generated: ${summary.createdAt}  `);
  lines.push(`LLM provider: \`${summary.provider}\`  `);
  lines.push(`Fixture set: \`${summary.fixtureSet ?? "seeded"}\``);
  lines.push("");

  lines.push(`## Headline metrics`);
  lines.push("");
  lines.push(`| Metric | Full pipeline | No-AI baseline (rules only) |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| Precision | ${pct(summary.aggregate.precision)} | ${pct(summary.baseline.precision)} |`);
  lines.push(`| Recall | ${pct(summary.aggregate.recall)} | ${pct(summary.baseline.recall)} |`);
  lines.push(
    `| F1 | ${(summary.aggregate.f1).toFixed(3)} | ${(summary.baseline.f1).toFixed(3)} |`,
  );
  lines.push(`| Seeded bugs detected | ${summary.aggregate.detectedBugs} / ${summary.aggregate.totalSeededBugs} | ${summary.baseline.detectedBugs} / ${summary.aggregate.totalSeededBugs} |`);
  lines.push(`| False positives | ${summary.aggregate.falsePositives} | ${summary.baseline.falsePositives} |`);
  lines.push("");
  if (summary.aggregate.cleanControls) {
    lines.push(
      `Clean PRs flagged: **${pct(summary.aggregate.cleanFlagRate ?? 0)}** of ${summary.aggregate.cleanControls}` +
        (summary.fixtureSet && summary.fixtureSet !== "seeded"
          ? ` (mined "presumed clean" commits, so this is an upper bound on the false-positive rate)  `
          : "  "),
    );
  }
  lines.push(`Median review latency: **${summary.aggregate.medianLatencyMs.toFixed(0)}ms**  `);
  if (summary.aggregate.p95LatencyMs !== undefined) lines.push(`p95 review latency: **${summary.aggregate.p95LatencyMs.toFixed(0)}ms**  `);
  lines.push(`Total cost across all ${summary.cases.length} fixtures: **$${summary.aggregate.totalCostUsd.toFixed(4)}**`);
  lines.push("");

  lines.push(`## Per-fixture results`);
  lines.push("");
  lines.push(`| Fixture | Trust score | Detected | Missed | False positives | Trivial |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const c of summary.cases) {
    lines.push(
      `| \`${c.caseId}\` | ${c.review.trustScore.score} (${c.review.trustScore.label}) | ${c.truePositives.length} | ${c.falseNegatives.length} | ${c.falsePositives} | ${c.review.isTrivial ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  const misses = summary.cases.filter((c) => c.falseNegatives.length > 0);
  if (misses.length > 0) {
    lines.push(`## Honest failure analysis: missed seeded bugs`);
    lines.push("");
    for (const c of misses) {
      lines.push(`- **${c.caseId}**: missed ${c.falseNegatives.join(", ")}`);
    }
    lines.push("");
  }

  const fps = summary.cases.filter((c) => c.falsePositives > 0);
  if (fps.length > 0) {
    lines.push(`## False positives by fixture`);
    lines.push("");
    for (const c of fps) {
      lines.push(`- **${c.caseId}**: ${c.falsePositives} finding(s) not attributable to a seeded bug`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
