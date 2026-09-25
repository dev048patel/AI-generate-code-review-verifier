import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mineFixtures } from "./mineFixtures.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * Builds a real-bug benchmark from public repos' history:
 *
 *   npm run mine -- --repo sindresorhus/ky --repo date-fns/date-fns --bugs 15 --clean 15
 *
 * Then evaluate against it:
 *
 *   LLM_PROVIDER=anthropic npm run eval -- --fixtures packages/eval-harness/fixtures-real --max-cost 5
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", multiple: true },
      out: { type: "string", default: path.join(pkgRoot, "fixtures-real") },
      cache: { type: "string", default: path.join(pkgRoot, ".mine-cache") },
      bugs: { type: "string", default: "15" },
      clean: { type: "string", default: "15" },
      "max-lines": { type: "string", default: "20" },
      "max-commits": { type: "string", default: "3000" },
    },
  });
  const repos = values.repo ?? [];
  if (repos.length === 0) throw new Error("Pass at least one --repo owner/name");

  for (const repo of repos) {
    console.log(`Mining ${repo}...`);
    const cases = await mineFixtures({
      repo,
      cacheDir: path.resolve(values.cache!),
      outDir: path.resolve(values.out!),
      maxBugs: Number(values.bugs),
      maxClean: Number(values.clean),
      maxChangedLines: Number(values["max-lines"]),
      maxCommits: Number(values["max-commits"]),
    });
    const bugs = cases.filter((c) => c.kind === "bug");
    console.log(`  ${bugs.length} reverted-fix bug case(s), ${cases.length - bugs.length} presumed-clean case(s)`);
    for (const c of bugs) console.log(`    ${c.id}: ${c.meta.source.subject}`);
  }
  console.log(`Fixtures written to ${path.resolve(values.out!)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
