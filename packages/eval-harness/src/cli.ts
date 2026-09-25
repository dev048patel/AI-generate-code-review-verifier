import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SqliteReviewStore } from "@acrv/core";
import type { ProviderName } from "@acrv/llm";
import { runBenchmark } from "./runBenchmark.js";
import { renderMarkdownReport } from "./report.js";

const outputDir = path.resolve(fileURLToPath(new URL("../output/", import.meta.url)));
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 *   npm run eval                                   # seeded fixtures, mock provider
 *   LLM_PROVIDER=anthropic npm run eval -- --fixtures fixtures-real --max-cost 5
 *   npm run eval -- --fixtures fixtures-real --limit 20 --out output/real
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "string" },
      limit: { type: "string" },
      "max-cost": { type: "string" },
      out: { type: "string" },
      "skip-mutation": { type: "boolean", default: false },
    },
  });
  const provider = (process.env.LLM_PROVIDER ?? "mock") as ProviderName;
  const fixturesDir = values.fixtures ? path.resolve(process.cwd(), values.fixtures) : undefined;
  // Real providers bill per call: default to a $5 cap unless one is given.
  const maxCostUsd = values["max-cost"] ? Number(values["max-cost"]) : provider === "mock" ? undefined : 5;
  console.log(
    `Running evaluation harness with provider="${provider}"${fixturesDir ? ` on ${fixturesDir}` : ""}` +
      `${maxCostUsd !== undefined ? ` (cost cap $${maxCostUsd})` : ""}...`,
  );

  const summary = await runBenchmark({
    provider,
    fixturesDir,
    limit: values.limit ? Number(values.limit) : undefined,
    maxCostUsd,
    skipMutation: values["skip-mutation"],
    onProgress: (done, total, cost) => console.log(`  [${done}/${total}] spend so far $${cost.toFixed(4)}`),
  });
  const reportDir = values.out ? path.resolve(process.cwd(), values.out) : outputDir;

  // Persist each fixture's review into the same store the dashboard/server
  // read from, so the eval report's per-fixture links open real review pages.
  const dbPath = process.env.ACRV_DB_PATH ?? path.join(repoRoot, "acrv-reviews.sqlite");
  const store = new SqliteReviewStore(dbPath);
  for (const c of summary.cases) {
    await store.put(c.review);
  }
  await store.close();

  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "eval-report.json"), JSON.stringify(summary, null, 2), "utf-8");
  const markdown = renderMarkdownReport(summary);
  await writeFile(path.join(reportDir, "eval-report.md"), markdown, "utf-8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`Full report written to ${path.join(reportDir, "eval-report.json")} and eval-report.md`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
