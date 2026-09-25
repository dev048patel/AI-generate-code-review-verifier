import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MockProvider } from "@acrv/llm";
import { LocalProcessExecutor } from "@acrv/mutation";
import { runReview, safeRelative } from "./runReview.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const sandboxRoot = path.join(repoRoot, "sandbox-runs");

beforeAll(async () => {
  await mkdir(sandboxRoot, { recursive: true });
});

const BUGGY_DIFF = `diff --git a/pay.ts b/pay.ts
--- a/pay.ts
+++ b/pay.ts
@@ -1,5 +1,7 @@
+export function charge(amount: number, count: number): number {
+  return amount / count;
+}
`;

const AFTER_SOURCE = `export function charge(amount: number, count: number): number {
  return amount / count;
}
`;

describe("runReview (end-to-end, mock provider)", () => {
  it("flags a division-by-zero risk, generates tests, and computes a trust score", async () => {
    const review = await runReview({
      repo: "acme/widgets",
      prNumber: 1,
      headSha: "abc123",
      prTitle: "Add charge()",
      prDescription: "",
      diffText: BUGGY_DIFF,
      afterFileContents: { "pay.ts": AFTER_SOURCE },
      llmProvider: new MockProvider(),
      sandboxRoot,
      skipMutation: true, // keep this test fast; mutation is covered by @acrv/mutation's own tests
    });

    expect(review.isTrivial).toBe(false);
    expect(review.risk?.findings.some((f) => f.title.toLowerCase().includes("division"))).toBe(true);
    expect(review.generatedTests.length).toBeGreaterThan(0);
    expect(review.testRun?.total).toBeGreaterThan(0);
    expect(review.trustScore.score).toBeLessThan(100);
    expect(review.trustScore.evidence.length).toBeGreaterThan(0);
  }, 30_000);

  it("skips the LLM and returns a clean trust score for a trivial docs-only PR", async () => {
    const review = await runReview({
      repo: "acme/widgets",
      prNumber: 2,
      headSha: "def456",
      prTitle: "Update README",
      prDescription: "",
      diffText: `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-old
+new
`,
      afterFileContents: { "README.md": "new\n" },
      llmProvider: new MockProvider(),
      sandboxRoot,
    });

    expect(review.isTrivial).toBe(true);
    expect(review.risk).toBeUndefined();
    expect(review.trustScore.label).toBe("trusted");
  });

  it("runs full mutation testing end-to-end when not skipped", async () => {
    const review = await runReview({
      repo: "acme/widgets",
      prNumber: 3,
      headSha: "ghi789",
      prTitle: "Add clamp()",
      prDescription: "",
      diffText: `diff --git a/calc.ts b/calc.ts
--- a/calc.ts
+++ b/calc.ts
@@ -1,3 +1,6 @@
+export function clamp(n: number, min: number, max: number): number {
+  if (n < min) return min;
+  if (n > max) return max;
+  return n;
+}
`,
      afterFileContents: {
        "calc.ts": `export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
`,
      },
      llmProvider: new MockProvider(),
      sandboxRoot,
    });

    expect(review.mutation).toBeDefined();
    expect(review.mutation!.totalMutants).toBeGreaterThan(0);
  }, 60_000);

  it("does not execute untrusted PR code without an executor that allows it", async () => {
    const review = await runReview({
      repo: "stranger/fork",
      prNumber: 3,
      headSha: "evil",
      prTitle: "Add charge()",
      prDescription: "",
      diffText: BUGGY_DIFF,
      afterFileContents: { "pay.ts": AFTER_SOURCE },
      llmProvider: new MockProvider(),
      sandboxRoot,
      untrusted: true,
    });

    expect(review.generatedTests.length).toBeGreaterThan(0);
    expect(review.testRun).toBeUndefined();
    expect(review.mutation).toBeUndefined();
    expect(review.execution).toMatchObject({ executor: "local", isolated: false });
    expect(review.execution?.skippedReason).toMatch(/not executed/);
  }, 30_000);

  it("executes untrusted code when the executor is explicitly allowed to", async () => {
    const review = await runReview({
      repo: "stranger/fork",
      prNumber: 4,
      headSha: "ci-vm",
      prTitle: "Add charge()",
      prDescription: "",
      diffText: BUGGY_DIFF.replaceAll("pay.ts", "src/billing/pay.ts"),
      afterFileContents: { "src/billing/pay.ts": AFTER_SOURCE },
      llmProvider: new MockProvider(),
      sandboxRoot,
      untrusted: true,
      executor: new LocalProcessExecutor({ allowUntrustedCode: true }),
      skipMutation: true,
    });

    expect(review.execution?.skippedReason).toBeUndefined();
    // Nested paths are preserved in the sandbox, so the generated test's relative import resolves.
    expect(review.testRun?.total).toBeGreaterThan(0);
    expect(review.testRun?.failures.some((f) => f.message.includes("Cannot find module"))).toBe(false);
  }, 30_000);
});

describe("safeRelative", () => {
  it("rejects paths that would escape the sandbox", () => {
    expect(() => safeRelative("../../etc/passwd")).toThrow(/unsafe path/);
    expect(() => safeRelative("/etc/passwd")).toThrow(/unsafe path/);
    expect(() => safeRelative("src/../../x.ts")).toThrow(/unsafe path/);
    expect(safeRelative("src/./a.ts")).toBe("src/a.ts");
  });
});
