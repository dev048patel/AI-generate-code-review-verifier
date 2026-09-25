import { describe, expect, it } from "vitest";
import { parseDiff } from "@acrv/core";
import { buildDiffFromFiles } from "./buildDiffFromFiles.js";

describe("buildDiffFromFiles", () => {
  it("produces a parseable diff for a modified file", () => {
    const diffText = buildDiffFromFiles([
      { path: "a.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
    ]);
    const parsed = parseDiff(diffText);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.newPath).toBe("a.ts");
    expect(parsed.files[0]!.isNew).toBe(false);
  });

  it("marks a brand-new file (before: null) as new", () => {
    const diffText = buildDiffFromFiles([{ path: "b.ts", before: null, after: "export const y = 1;\n" }]);
    const parsed = parseDiff(diffText);
    expect(parsed.files[0]!.isNew).toBe(true);
    expect(parsed.files[0]!.changedLines).toContain(1);
  });

  it("marks a deleted file (after: null) as deleted", () => {
    const diffText = buildDiffFromFiles([{ path: "c.ts", before: "export const z = 1;\n", after: null }]);
    const parsed = parseDiff(diffText);
    expect(parsed.files[0]!.isDeleted).toBe(true);
  });

  it("concatenates diffs for multiple files", () => {
    const diffText = buildDiffFromFiles([
      { path: "a.ts", before: "1", after: "2" },
      { path: "b.ts", before: "3", after: "4" },
    ]);
    const parsed = parseDiff(diffText);
    expect(parsed.files.map((f) => f.newPath)).toEqual(["a.ts", "b.ts"]);
  });
});
