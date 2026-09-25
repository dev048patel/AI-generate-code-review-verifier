import { describe, expect, it } from "vitest";
import { parseDiff, extractChangedFunctions } from "@acrv/core";
import { MockProvider } from "./MockProvider.js";

const BUGGY_DIFF = `diff --git a/src/pay.ts b/src/pay.ts
--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,4 +1,4 @@
 function charge(amount: number, user) {
-  if (user === null) return;
   return db.query("SELECT * FROM accounts WHERE id = " + user.id);
 }
`;

describe("MockProvider", () => {
  it("classifies a risky diff as medium/high/critical with findings", async () => {
    const parsed = parseDiff(BUGGY_DIFF);
    const provider = new MockProvider();
    const result = await provider.classify({
      repo: "acme/widgets",
      prTitle: "Add charge function",
      prDescription: "",
      files: parsed.files,
      changedFunctions: [],
    });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(["medium", "high", "critical"]).toContain(result.riskLevel);
    expect(result.fromFallback).toBe(false);
  });

  it("returns no findings and risk 'none' for a clean diff", async () => {
    const clean = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 function f() {
+  const y = 1;
 }
`);
    const provider = new MockProvider();
    const result = await provider.classify({
      repo: "acme/widgets",
      prTitle: "trivial change",
      prDescription: "",
      files: clean.files,
      changedFunctions: [],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.riskLevel).toBe("none");
  });

  it("incorporates function-level heuristics for changed functions", async () => {
    const source = `function last(arr: number[]): number {
  return arr[arr.length];
}`;
    const fns = extractChangedFunctions("a.ts", source, [2]);
    const provider = new MockProvider();
    const result = await provider.classify({
      repo: "acme/widgets",
      prTitle: "add last()",
      prDescription: "",
      files: [],
      changedFunctions: fns,
    });
    expect(result.findings.some((f) => f.title.includes("Out-of-bounds"))).toBe(true);
  });

  it("reports token/latency estimates", async () => {
    const provider = new MockProvider();
    const result = await provider.classify({
      repo: "acme/widgets",
      prTitle: "x",
      prDescription: "",
      files: [],
      changedFunctions: [],
    });
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.modelId).toBe("mock-heuristic-v1");
  });
});
