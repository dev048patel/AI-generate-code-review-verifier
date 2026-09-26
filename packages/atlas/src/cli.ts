#!/usr/bin/env -S npx tsx
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { diffGraphs } from "./diff.js";
import { buildFlows, diffFlows } from "./flow.js";
import { buildGraph } from "./graph.js";
import { git } from "./git.js";
import { analyzeHistory, entryFilesFromPackageJson, factsAtRef, factsOfWorktree, graphAtRef } from "./history.js";
import { renderDiffText, renderFlowDiffText, renderFlowText, renderGraphText, renderHistoryText } from "./report.js";
import type { FileFacts } from "./types.js";

const USAGE = `acrv-atlas <command> [options]   (run inside a git repo)

  diff     What your branch / uncommitted work changes vs. the base, before you open a PR
             --base <ref>        base to compare against (default: origin/main, main, master)
             --committed         compare HEAD instead of the working tree
             --fail-on-new       exit 1 if the change introduces high-severity findings
  flow     How a request moves through the code, step by step
             acrv-atlas flow                     list every route
             acrv-atlas flow "POST /login"       the steps for routes matching this text
             --ref <ref>   (default: working tree)   --explain   add a plain-English line per step
  map      Structure, routes and gaps at a commit        --ref <ref> (default HEAD)
  history  How the repo evolved across commits            --max <n> (default 150)

  Common: --json <file> writes the full result as JSON (the dashboard can load it).`;

async function defaultBase(cwd: string): Promise<string> {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
      return ref;
    } catch {
      /* try next */
    }
  }
  throw new Error("No base branch found; pass --base <ref>");
}

async function entries(cwd: string, ref: string | undefined): Promise<string[]> {
  try {
    return entryFilesFromPackageJson(ref ? await git(cwd, ["show", `${ref}:package.json`]) : await readFile(`${cwd}/package.json`, "utf-8"));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      base: { type: "string" },
      ref: { type: "string" },
      max: { type: "string", default: "150" },
      json: { type: "string" },
      committed: { type: "boolean", default: false },
      "fail-on-new": { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const cwd = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  let result: unknown;

  if (command === "diff") {
    const baseRef = values.base ?? (await defaultBase(cwd));
    const mergeBase = (await git(cwd, ["merge-base", baseRef, "HEAD"])).trim();
    const beforeFacts = (await factsAtRef(cwd, mergeBase)).facts;
    const afterFacts = values.committed ? (await factsAtRef(cwd, "HEAD")).facts : await factsOfWorktree(cwd);
    const before = buildGraph(beforeFacts, { commit: mergeBase, entryFiles: await entries(cwd, mergeBase) });
    const after = buildGraph(afterFacts, { entryFiles: await entries(cwd, values.committed ? "HEAD" : undefined) });
    const d = diffGraphs(before, after);
    const flows = diffFlows(buildFlows(beforeFacts), buildFlows(afterFacts));
    console.log(renderDiffText(d, values.committed ? `HEAD vs ${baseRef}` : `your working tree vs ${baseRef}`));
    console.log("\n" + renderFlowDiffText(flows));
    result = { base: mergeBase, diff: d, flows: flows.filter((f) => f.status !== "same"), before: before.metrics, after: after.metrics };
    if (values["fail-on-new"] && d.newFindings.some((f) => f.severity === "high" || f.severity === "critical")) process.exitCode = 1;
  } else if (command === "flow") {
    const facts: FileFacts[] = values.ref && values.ref !== "HEAD" ? (await factsAtRef(cwd, values.ref)).facts : await factsOfWorktree(cwd);
    const flows = buildFlows(facts);
    const query = positionals.join(" ").trim().toLowerCase();
    const matches = query ? flows.filter((f) => `${f.method} ${f.path}`.toLowerCase().includes(query)) : [];
    if (!query) {
      for (const f of flows) {
        const warn = f.steps.filter((s) => s.kind === "missing").map((s) => s.title.toLowerCase());
        console.log(`${`${f.method} ${f.path}`.padEnd(48)} ${String(f.steps.length).padStart(2)} steps${warn.length ? `   ⚠ ${warn.join(", ")}` : ""}`);
      }
      if (flows.length === 0) console.log("No HTTP routes found.");
    } else if (matches.length === 0) {
      console.log(`No route matches "${query}". Run without arguments to list them.`);
      process.exitCode = 1;
    } else {
      console.log(matches.map((f) => renderFlowText(f, { explain: values.explain })).join("\n\n"));
    }
    result = query ? matches : flows;
  } else if (command === "map") {
    const g = await graphAtRef(cwd, values.ref ?? "HEAD");
    console.log(renderGraphText(g));
    result = g;
  } else if (command === "history") {
    const a = await analyzeHistory(cwd, {
      maxCommits: Number(values.max),
      onProgress: (done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\r  analyzing commit ${done}/${total}`);
        else if (done === total || done % 50 === 0) process.stderr.write(`  analyzed ${done}/${total} commits\n`);
      },
    });
    if (process.stderr.isTTY) process.stderr.write("\n");
    console.log(renderHistoryText(a));
    result = a;
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }

  if (values.json) {
    await writeFile(values.json, JSON.stringify(result, null, 2), "utf-8");
    console.error(`Wrote ${values.json}`);
  }
}

main().catch((err) => {
  console.error(String(err).split("\n")[0]);
  process.exitCode = 1;
});
