import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff/parseDiff.js";
import { checkTrivial } from "./trivialCheck.js";

describe("checkTrivial", () => {
  it("flags a docs-only PR as trivial", () => {
    const diff = parseDiff(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-old text
+new text
`);
    const result = checkTrivial(diff);
    expect(result.isTrivial).toBe(true);
  });

  it("flags a comment-only source change as trivial", () => {
    const diff = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-// old comment
+// new comment
 export const x = 1;
`);
    expect(checkTrivial(diff).isTrivial).toBe(true);
  });

  it("does not flag a real logic change as trivial", () => {
    const diff = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function f(x: number) {
-  return x + 1;
+  return x - 1;
 }
`);
    expect(checkTrivial(diff).isTrivial).toBe(false);
  });

  it("treats an empty diff as trivial", () => {
    expect(checkTrivial({ files: [] }).isTrivial).toBe(true);
  });
});
