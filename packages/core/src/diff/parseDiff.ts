import type { DiffFile, DiffHunk, ParsedDiff } from "../types.js";

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified git diff (as produced by `git diff` or the GitHub compare API)
 * into structured per-file hunks with computed "after" line numbers for each
 * changed line, so downstream stages can map changes onto AST ranges.
 */
export function parseDiff(diffText: string): ParsedDiff {
  const lines = diffText.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let newLineCursor = 0;

  const pushCurrent = () => {
    if (current) files.push(current);
    current = null;
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fileMatch = FILE_HEADER_RE.exec(line);
    if (fileMatch) {
      pushCurrent();
      current = {
        oldPath: fileMatch[1] ?? "",
        newPath: fileMatch[2] ?? "",
        isNew: false,
        isDeleted: false,
        isRenamed: fileMatch[1] !== fileMatch[2],
        isBinary: false,
        hunks: [],
        changedLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith("Binary files")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      const newStart = Number(hunkMatch[3]);
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart,
        newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      newLineCursor = newStart;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push(line);
      current.changedLines.push(newLineCursor);
      newLineCursor++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push(line);
      // deletions don't consume a new-file line number
    } else {
      currentHunk.lines.push(line);
      newLineCursor++;
    }
  }
  pushCurrent();

  return { files };
}

/** Returns true if a diff file only touches non-executable content (docs, comments, formatting-only). */
export function isDocsOrConfigOnly(file: DiffFile): boolean {
  const docExtensions = [".md", ".mdx", ".txt", ".rst"];
  const configFiles = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".gitignore",
    "LICENSE",
  ];
  const path = file.newPath || file.oldPath;
  if (docExtensions.some((ext) => path.endsWith(ext))) return true;
  if (configFiles.some((name) => path.endsWith(name))) return true;
  return false;
}
