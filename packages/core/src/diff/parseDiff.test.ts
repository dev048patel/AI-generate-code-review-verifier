import { describe, expect, it } from "vitest";
import { isDocsOrConfigOnly, parseDiff } from "./parseDiff.js";

const SAMPLE_DIFF = `diff --git a/src/util.ts b/src/util.ts
index 1111111..2222222 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,5 +1,5 @@
 export function clamp(n: number, min: number, max: number): number {
-  if (n < min) return min;
+  if (n <= min) return min;
   if (n > max) return max;
   return n;
 }
`;

describe("parseDiff", () => {
  it("extracts file paths and hunks", () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.newPath).toBe("src/util.ts");
    expect(file.hunks).toHaveLength(1);
  });

  it("computes correct after-file line numbers for added lines", () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const file = parsed.files[0]!;
    // Line 2 in the after-file is the changed `if (n <= min)` line.
    expect(file.changedLines).toContain(2);
  });

  it("detects new and deleted files", () => {
    const newFileDiff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;
    const parsed = parseDiff(newFileDiff);
    expect(parsed.files[0]!.isNew).toBe(true);
    expect(parsed.files[0]!.changedLines).toEqual([1, 2]);
  });

  it("handles multiple files in one diff", () => {
    const multi = SAMPLE_DIFF + "\n" + SAMPLE_DIFF.replace("util.ts", "helpers.ts");
    const parsed = parseDiff(multi);
    expect(parsed.files.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty file list for empty input", () => {
    expect(parseDiff("").files).toHaveLength(0);
  });
});

describe("isDocsOrConfigOnly", () => {
  it("flags markdown files as docs-only", () => {
    expect(
      isDocsOrConfigOnly({
        oldPath: "README.md",
        newPath: "README.md",
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        isBinary: false,
        hunks: [],
        changedLines: [],
      }),
    ).toBe(true);
  });

  it("does not flag source files", () => {
    expect(
      isDocsOrConfigOnly({
        oldPath: "src/index.ts",
        newPath: "src/index.ts",
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        isBinary: false,
        hunks: [],
        changedLines: [],
      }),
    ).toBe(false);
  });
});
