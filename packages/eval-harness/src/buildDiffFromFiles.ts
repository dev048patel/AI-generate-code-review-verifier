import { structuredPatch } from "diff";

export interface FileChange {
  path: string;
  before: string | null; // null = new file
  after: string | null; // null = deleted file
}

/**
 * Builds a `git diff`-style unified diff string from full before/after file
 * contents, so evaluation-harness fixtures can be authored as plain
 * before/after source files (easy to read and review) instead of hand-typed
 * diff syntax (easy to get subtly wrong), while still exercising the real
 * `parseDiff` used in production.
 */
export function buildDiffFromFiles(changes: FileChange[]): string {
  return changes.map(buildSingleFileDiff).join("\n");
}

function buildSingleFileDiff(change: FileChange): string {
  const { path: filePath, before, after } = change;
  const isNew = before === null;
  const isDeleted = after === null;
  const oldStr = before ?? "";
  const newStr = after ?? "";

  const patch = structuredPatch(filePath, filePath, oldStr, newStr, "", "");

  const lines: string[] = [`diff --git a/${filePath} b/${filePath}`];
  if (isNew) lines.push("new file mode 100644");
  if (isDeleted) lines.push("deleted file mode 100644");
  lines.push(`--- ${isNew ? "/dev/null" : `a/${filePath}`}`);
  lines.push(`+++ ${isDeleted ? "/dev/null" : `b/${filePath}`}`);

  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunk.lines);
  }

  return lines.join("\n") + "\n";
}
