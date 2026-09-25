import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDiff, type SeededBug } from "@acrv/core";
import { runProcess, scrubbedEnv } from "@acrv/mutation";
import type { FixtureMeta } from "../loadFixtures.js";

const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__|test|tests)\//;
/** Conventional-commit or plain-English bug-fix subjects. Deliberately strict: a noisy label set is worse than a small one. */
const FIX_SUBJECT_RE = /^(fix(\(.+\))?!?:|fix(es|ed)? (a |the )?(bug|crash|regression|issue|error|typo in logic)|bugfix)/i;
const NOT_A_FIX_RE =
  /\b(typo|lint|format|docs?|readme|tests?|ci|deps?|bump|revert|merge|types?|typings|compat\w*|es5|browsers?|lookbehind|unused|perf\w*|refactor|style|build)\b/i;
/** Scopes whose fixes aren't runtime behavior changes. */
const NON_BEHAVIOR_SCOPE_RE = /^fix\((types?|typings|deps?|docs?|ci|build|lint|test)\)/i;

export interface MineOptions {
  /** GitHub "owner/name" of a public repo. */
  repo: string;
  /** Where clones are cached between runs. */
  cacheDir: string;
  /** Mine an existing local clone instead of cloning from GitHub (private repos, tests). */
  localRepoDir?: string;
  /** Output directory; one fixture directory is written per mined case. */
  outDir: string;
  maxBugs?: number;
  maxClean?: number;
  /** Only consider fixes that change at most this many source lines (small fixes localize the bug). */
  maxChangedLines?: number;
  /** How far back to search. */
  maxCommits?: number;
}

export interface MinedCase {
  id: string;
  kind: "bug" | "clean";
  commit: string;
  meta: FixtureMeta & { source: { repo: string; commit: string; subject: string; kind: "reverted-fix" | "presumed-clean" } };
}

async function git(dir: string, args: string[], timeoutMs = 300_000): Promise<string> {
  const { stdout } = await runProcess("git", args, dir, timeoutMs, {
    acceptExitCode: (c) => c === 0,
    label: `git ${args[0]}`,
    env: scrubbedEnv(dir, { GIT_TERMINAL_PROMPT: "0" }),
    maxOutputBytes: 64 * 1024 * 1024,
  });
  return stdout;
}

async function ensureClone(repo: string, cacheDir: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repo "${repo}" (expected owner/name)`);
  const dir = path.join(cacheDir, repo.replace("/", "__"));
  await mkdir(cacheDir, { recursive: true });
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    await git(dir, ["fetch", "--quiet", "origin"]);
  } catch {
    // Full (bare-ish) clone: partial clones lazily fetch blobs per `git show`, which is slow and brittle.
    await git(cacheDir, ["clone", "--quiet", "--no-checkout", `https://github.com/${repo}.git`, dir], 900_000);
  }
  return dir;
}

interface CommitInfo {
  sha: string;
  subject: string;
}

async function listCommits(dir: string, max: number): Promise<CommitInfo[]> {
  const out = await git(dir, ["log", "--no-merges", "--format=%H%x1f%s", `-n`, String(max), "HEAD"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split("\x1f");
      return { sha: sha as string, subject: subject ?? "" };
    });
}

interface FileStat {
  file: string;
  added: number;
  removed: number;
}

async function changedFiles(dir: string, sha: string): Promise<FileStat[] | null> {
  const out = await git(dir, ["diff-tree", "--no-commit-id", "-r", "--numstat", "--diff-filter=AMDRC", "-M", sha]);
  const stats: FileStat[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [a, r, file] = line.split("\t");
    if (a === "-" || r === "-" || !file) return null; // binary
    stats.push({ file, added: Number(a), removed: Number(r) });
  }
  return stats;
}

/** Only modified (not added/deleted/renamed) source files, so both sides of the PR exist. */
async function onlyModified(dir: string, sha: string, files: string[]): Promise<boolean> {
  const out = await git(dir, ["diff-tree", "--no-commit-id", "-r", "--name-status", sha, "--", ...files]);
  return out.split("\n").filter(Boolean).every((l) => l.startsWith("M\t"));
}

async function show(dir: string, rev: string, file: string): Promise<string> {
  return git(dir, ["show", `${rev}:${file}`]);
}

/**
 * Builds a real-bug benchmark from a repo's history:
 *
 *  - Bug cases: a small, source-only bug-fix commit, *reversed*. The PR under
 *    review takes the fixed code back to the buggy code, so the bug is real
 *    (someone had to fix it) and its location is exactly the lines the fix
 *    touched. The PR title is neutral -- the fix message would give it away.
 *  - Clean cases: small source-only commits that aren't fixes and whose files
 *    no later fix touched within the next `window` commits. "Presumed clean":
 *    the flag rate on these is an upper bound on the false-positive rate.
 */
export async function mineFixtures(options: MineOptions): Promise<MinedCase[]> {
  const { repo, cacheDir, outDir, maxBugs = 20, maxClean = 20, maxChangedLines = 20, maxCommits = 3000 } = options;
  const dir = options.localRepoDir ?? (await ensureClone(repo, cacheDir));
  const commits = await listCommits(dir, maxCommits);
  const slug = repo.replace("/", "__");
  const cases: MinedCase[] = [];
  const fixIndexes: number[] = [];
  const fixFiles = new Map<number, Set<string>>();

  // Pass 1: bug-fix commits (newest first).
  for (const [i, c] of commits.entries()) {
    if (!FIX_SUBJECT_RE.test(c.subject)) continue;
    const behaviorFix = !NON_BEHAVIOR_SCOPE_RE.test(c.subject) && !NOT_A_FIX_RE.test(c.subject.replace(/^fix(\([^)]*\))?!?:/i, ""));
    const stats = await changedFiles(dir, c.sha);
    if (!stats) continue;
    const sources = stats.filter((s) => CODE_RE.test(s.file) && !TEST_RE.test(s.file) && !s.file.endsWith(".d.ts"));
    fixIndexes.push(i);
    fixFiles.set(i, new Set(sources.map((s) => s.file)));
    const others = stats.filter((s) => !sources.includes(s) && !TEST_RE.test(s.file));
    // Every fix counts for excluding "clean" candidates below; only behavior fixes become bug cases.
    if (!behaviorFix || cases.filter((x) => x.kind === "bug").length >= maxBugs) continue;
    if (sources.length === 0 || sources.length > 2 || others.length > 0) continue;
    const changed = sources.reduce((n, s) => n + s.added + s.removed, 0);
    if (changed === 0 || changed > maxChangedLines) continue;
    const files = sources.map((s) => s.file);
    if (!(await onlyModified(dir, c.sha, files))) continue;

    const before: Record<string, string> = {}; // fixed
    const after: Record<string, string> = {}; // buggy
    for (const f of files) {
      before[f] = await show(dir, c.sha, f);
      after[f] = await show(dir, `${c.sha}^`, f);
    }
    const bugs = bugLocations(await git(dir, ["diff", "--no-color", "-U0", c.sha, `${c.sha}^`, "--", ...files]), c);
    if (bugs.length === 0) continue;

    const id = `${slug}__fix-${c.sha.slice(0, 10)}`;
    const meta: MinedCase["meta"] = {
      prTitle: `Update ${files.map((f) => path.basename(f)).join(", ")}`,
      prDescription: "",
      files,
      isCleanControl: false,
      seededBugs: bugs,
      source: { repo, commit: c.sha, subject: c.subject, kind: "reverted-fix" },
    };
    await writeCase(outDir, id, meta, before, after);
    cases.push({ id, kind: "bug", commit: c.sha, meta });
  }

  // Pass 2: presumed-clean commits.
  const WINDOW = 50;
  for (const [i, c] of commits.entries()) {
    if (cases.filter((x) => x.kind === "clean").length >= maxClean) break;
    if (FIX_SUBJECT_RE.test(c.subject) || /revert|merge/i.test(c.subject)) continue;
    const stats = await changedFiles(dir, c.sha);
    if (!stats) continue;
    // Source changes only go into the fixture; accompanying tests/docs are fine (normal commits have them).
    const sources = stats.filter((s) => CODE_RE.test(s.file) && !TEST_RE.test(s.file) && !s.file.endsWith(".d.ts"));
    const nonSource = stats.filter((s) => !sources.includes(s));
    if (sources.length === 0 || sources.length > 2) continue;
    if (nonSource.some((s) => !TEST_RE.test(s.file) && !/\.(md|txt)$/i.test(s.file))) continue;
    const changed = sources.reduce((n, s) => n + s.added + s.removed, 0);
    if (changed < 3 || changed > 40) continue;
    const files = sources.map((s) => s.file);
    // Commits are newest-first: later fixes have smaller indexes.
    const laterFix = fixIndexes.some((fi) => fi < i && fi >= i - WINDOW && files.some((f) => fixFiles.get(fi)?.has(f)));
    if (laterFix || i < WINDOW) continue;
    if (!(await onlyModified(dir, c.sha, files))) continue;

    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (const f of files) {
      before[f] = await show(dir, `${c.sha}^`, f);
      after[f] = await show(dir, c.sha, f);
    }
    const id = `${slug}__clean-${c.sha.slice(0, 10)}`;
    const meta: MinedCase["meta"] = {
      prTitle: c.subject.slice(0, 120),
      prDescription: "",
      files,
      isCleanControl: true,
      seededBugs: [],
      source: { repo, commit: c.sha, subject: c.subject, kind: "presumed-clean" },
    };
    await writeCase(outDir, id, meta, before, after);
    cases.push({ id, kind: "clean", commit: c.sha, meta });
  }

  return cases;
}

/** Lines of the buggy version (the reversed fix's "+" side) that the fix had to change. */
export function bugLocations(reverseDiff: string, commit: CommitInfo): SeededBug[] {
  const bugs: SeededBug[] = [];
  for (const file of parseDiff(reverseDiff).files) {
    for (const [h, hunk] of file.hunks.entries()) {
      // Pure deletions in the buggy version (the fix only added lines) point at the line after the gap.
      const start = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
      const end = hunk.newLines === 0 ? start : hunk.newStart + hunk.newLines - 1;
      bugs.push({
        id: `${commit.sha.slice(0, 10)}-${file.newPath}-${h}`,
        description: `Reverted by fix ${commit.sha.slice(0, 10)}: ${commit.subject}`,
        location: { file: file.newPath, line: start, endLine: end },
        category: "reverted-fix",
        expectDetection: true,
      });
    }
  }
  // One fix = one bug: recall is per fix, with any of its hunks counting as a detection.
  return bugs.length > 0 ? [{ ...bugs[0]!, alternateLocations: bugs.slice(1).map((b) => b.location) }] : [];
}

async function writeCase(
  outDir: string,
  id: string,
  meta: MinedCase["meta"],
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<void> {
  const caseDir = path.join(outDir, id);
  for (const [side, files] of [
    ["before", before],
    ["after", after],
  ] as const) {
    for (const [f, content] of Object.entries(files)) {
      const target = path.join(caseDir, side, f);
      if (!target.startsWith(caseDir + path.sep)) throw new Error(`Unsafe path in mined commit: ${f}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    }
  }
  await writeFile(path.join(caseDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
}
