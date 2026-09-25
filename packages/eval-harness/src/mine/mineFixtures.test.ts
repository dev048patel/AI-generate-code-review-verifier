import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixtures } from "../loadFixtures.js";
import { bugLocations, mineFixtures } from "./mineFixtures.js";

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}

async function commit(file: string, content: string, subject: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), content, "utf-8");
  git("add", ".");
  git("commit", "-qm", subject);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acrv-mine-"));
  repo = path.join(root, "repo");
  await mkdir(repo);
  git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mineFixtures", () => {
  it("turns a small bug fix into a reverted-fix case whose bug sits on the lines the fix changed", async () => {
    const buggy = "export function last<T>(xs: T[]): T | undefined {\n  return xs[xs.length];\n}\n";
    await commit("src/last.ts", buggy, "feat: add last()");
    await commit("src/last.ts", buggy.replace("xs[xs.length]", "xs[xs.length - 1]"), "fix: off-by-one in last()");
    await commit("src/last.ts", buggy.replace("xs[xs.length]", "xs[xs.length - 1]").replace("T | undefined", "T|undefined"), "fix(types): tidy signature");

    const out = path.join(root, "fixtures");
    const cases = await mineFixtures({ repo: "acme/demo", cacheDir: root, outDir: out, localRepoDir: repo });

    const bugs = cases.filter((c) => c.kind === "bug");
    expect(bugs).toHaveLength(1); // the fix(types) commit is not a behavior fix
    const [bug] = bugs;
    expect(bug!.meta.prTitle).toBe("Update last.ts"); // neutral: the fix message would leak the answer
    expect(bug!.meta.seededBugs[0]!.location).toMatchObject({ file: "src/last.ts", line: 2 });

    const [fixture] = await loadFixtures(out);
    // The "PR" goes from fixed (before) to buggy (after).
    expect(await readFile(path.join(fixture!.dir, "before", "src/last.ts"), "utf-8")).toContain("xs.length - 1");
    expect(await readFile(path.join(fixture!.dir, "after", "src/last.ts"), "utf-8")).toContain("xs[xs.length]");
  });
});

describe("bugLocations", () => {
  it("points pure-deletion hunks at the line after the gap and keeps other hunks as alternates", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,1 +2,0 @@
-  if (!x) return;
@@ -10,1 +9,1 @@
-  return a < b;
+  return a <= b;
`;
    const [bug] = bugLocations(diff, { sha: "abcdef1234567", subject: "fix: x" });
    expect(bug!.location).toEqual({ file: "a.ts", line: 3, endLine: 3 });
    expect(bug!.alternateLocations).toEqual([{ file: "a.ts", line: 9, endLine: 9 }]);
  });
});
