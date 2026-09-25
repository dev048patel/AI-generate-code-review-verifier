import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockProvider } from "@acrv/llm";
import { LocalProcessExecutor } from "@acrv/mutation";
import { gitDiff, readFilesAtRevision } from "./git.js";
import { executeWorkspace, runWorkspaceReview } from "./runWorkspaceReview.js";

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), content, "utf-8");
}

/** A two-commit repo: base adds a helper module, head adds a buggy exported function that imports it. */
async function makeRepo(): Promise<{ base: string; head: string }> {
  await write("package.json", JSON.stringify({ name: "demo", type: "module" }));
  await write("src/util/math.ts", "export const half = (n: number): number => n / 2;\n");
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await write(
    "src/billing/pay.ts",
    'import { half } from "../util/math";\n\nexport function split(total: number, people: number): number {\n  return half(total) / people;\n}\n',
  );
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "head");
  return { base, head: git("rev-parse", "HEAD") };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acrv-ws-"));
  repo = path.join(root, "repo");
  await mkdir(repo);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("git helpers", () => {
  it("diffs merge-base..head and reads file contents from git objects", async () => {
    const { base, head } = await makeRepo();
    const diff = await gitDiff(repo, base, head);
    expect(diff).toContain("diff --git a/src/billing/pay.ts b/src/billing/pay.ts");
    const files = await readFilesAtRevision(repo, head, ["src/billing/pay.ts"]);
    expect(files["src/billing/pay.ts"]).toContain("export function split");
  });

  it("never follows a committed symlink to read a file outside the repo", async () => {
    await makeRepo();
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "TOP-SECRET-KEY", "utf-8");
    await symlink(secret, path.join(repo, "src", "leak.ts"));
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "symlink");
    const head = git("rev-parse", "HEAD");
    const files = await readFilesAtRevision(repo, head, ["src/leak.ts"]);
    expect(files["src/leak.ts"]).toBeUndefined();
    expect(JSON.stringify(files)).not.toContain("TOP-SECRET-KEY");
  });
});

describe("executeWorkspace", () => {
  it("runs generated tests inside the real checkout, resolving the project's own imports, then removes them", async () => {
    const { base, head } = await makeRepo();
    const result = await executeWorkspace({
      repoDir: repo,
      workspaceDir: root,
      baseSha: base,
      headSha: head,
      executor: new LocalProcessExecutor({ allowUntrustedCode: true }),
      untrusted: true,
      installDependencies: false,
      skipMutation: true,
    });

    expect(result.execution.skippedReason).toBeUndefined();
    expect(result.generatedTests.length).toBeGreaterThan(0);
    expect(result.testRun?.total).toBeGreaterThan(0);
    // `../util/math` resolved from the real tree -- the flattened sandbox couldn't do this.
    expect(result.testRun?.failures.some((f) => /Cannot find|Failed to load/.test(f.message))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  }, 60_000);

  it("refuses to execute untrusted code with an executor that doesn't allow it", async () => {
    const { base, head } = await makeRepo();
    const result = await executeWorkspace({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      executor: new LocalProcessExecutor(),
      untrusted: true,
    });
    expect(result.testRun).toBeUndefined();
    expect(result.execution.skippedReason).toMatch(/not executed/);
  });

  it("notes a missing test runner instead of failing", async () => {
    const { base, head } = await makeRepo();
    const result = await executeWorkspace({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      executor: new LocalProcessExecutor({ allowUntrustedCode: true }),
      installDependencies: false,
    });
    expect(result.execution.notes?.join("\n")).toMatch(/no supported test runner/);
  }, 60_000);
});

describe("runWorkspaceReview", () => {
  it("combines LLM analysis with an execute phase supplied from elsewhere", async () => {
    const { base, head } = await makeRepo();
    const execution = await executeWorkspace({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      executor: new LocalProcessExecutor({ allowUntrustedCode: true }),
      installDependencies: false,
      skipMutation: true,
    });
    const review = await runWorkspaceReview({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      repo: "acme/demo",
      prNumber: 7,
      prTitle: "Add split()",
      prDescription: "",
      llmProvider: new MockProvider(),
      execution: JSON.parse(JSON.stringify(execution)),
    });
    expect(review.risk).toBeDefined();
    expect(review.testRun?.total).toBe(execution.testRun?.total);
    expect(review.risk?.findings.some((f) => /division/i.test(f.title))).toBe(true);
  }, 60_000);

  it("discards execution results produced for a different commit", async () => {
    const { base, head } = await makeRepo();
    const review = await runWorkspaceReview({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      repo: "acme/demo",
      prNumber: 7,
      prTitle: "Add split()",
      prDescription: "",
      execution: {
        headSha: "0000000deadbeef",
        execution: { executor: "local", isolated: false },
        generatedTests: [],
        ownTestsMutation: { mutationScore: 100, killed: 1, survived: 0, timeout: 0, noCoverage: 0, totalMutants: 1, survivedMutants: [], durationMs: 1 },
      },
    });
    expect(review.ownTestsMutation).toBeUndefined();
    expect(review.execution?.skippedReason).toMatch(/discarded/);
  });
});

// Needs network (npm registry): installs the project's deps and Stryker, then mutation-tests changed lines
// against the project's own vitest suite. Run with ACRV_NETWORK_TESTS=1.
describe.runIf(process.env.ACRV_NETWORK_TESTS === "1")("executeWorkspace (network)", () => {
  it("finds changed lines the project's own tests don't cover", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "demo", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "2.1.9" } }),
    );
    await write("src/range.ts", "export function inRange(n: number, lo: number, hi: number): boolean {\n  return n >= lo && n <= hi;\n}\n");
    await write(
      "src/range.test.ts",
      'import { expect, it } from "vitest";\nimport { inRange } from "./range";\nit("mid", () => expect(inRange(5, 0, 10)).toBe(true));\n',
    );
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: repo });
    await write(".gitignore", "node_modules\nreports\n");
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await write(
      "src/range.ts",
      "export function inRange(n: number, lo: number, hi: number): boolean {\n  return n >= lo && n <= hi;\n}\n\nexport function clampPct(n: number): number {\n  if (n < 0) return 0;\n  if (n > 100) return 100;\n  return n;\n}\n",
    );
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "head");
    const head = git("rev-parse", "HEAD");

    const result = await executeWorkspace({
      repoDir: repo,
      workspaceDir: root,
      baseSha: base,
      headSha: head,
      executor: new LocalProcessExecutor({ allowUntrustedCode: true }),
    });
    expect(result.ownTestsMutation?.totalMutants).toBeGreaterThan(0);
    // Only the new function's lines were mutated, and nothing tests them.
    expect(result.ownTestsMutation?.survivedMutants.every((m) => m.file === "src/range.ts" && m.line >= 5)).toBe(true);
    expect(result.ownTestsMutation?.mutationScore).toBeLessThan(50);
  }, 600_000);
});
