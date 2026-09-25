import { runProcess, scrubbedEnv } from "@acrv/mutation";

/** Source files the pipeline reads for AST analysis and the LLM prompt. */
const TEXT_SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|md)$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 300;

async function git(repoDir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  // Never run hooks, external diff drivers, or textconv filters: the repo's
  // attributes are PR-controlled, and this runs on the reviewer's host.
  const { stdout } = await runProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...args],
    repoDir,
    timeoutMs,
    { acceptExitCode: (c) => c === 0, label: `git ${args[0]}`, env: scrubbedEnv(repoDir, { GIT_TERMINAL_PROMPT: "0" }) },
  );
  return stdout;
}

/** The merge base of base and head, falling back to base itself when history is too shallow to find one. */
export async function mergeBase(repoDir: string, baseSha: string, headSha: string): Promise<string> {
  try {
    return (await git(repoDir, ["merge-base", baseSha, headSha])).trim();
  } catch {
    return baseSha;
  }
}

/** The PR's unified diff, exactly as GitHub shows it (merge-base..head). */
export async function gitDiff(repoDir: string, baseSha: string, headSha: string): Promise<string> {
  const base = await mergeBase(repoDir, baseSha, headSha);
  return git(repoDir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", `${base}`, `${headSha}`, "--"], 120_000);
}

/**
 * Reads the "after" content of changed text source files from git objects
 * at `headSha` -- never from the working tree, so a symlink committed by the
 * PR (e.g. `src/a.ts -> ~/.ssh/id_rsa`) yields the link text, not the target.
 */
export async function readFilesAtRevision(
  repoDir: string,
  headSha: string,
  files: string[],
): Promise<Record<string, string>> {
  const wanted = files.filter((f) => TEXT_SOURCE_RE.test(f)).slice(0, MAX_FILES);
  const out: Record<string, string> = {};
  if (wanted.length === 0) return out;

  // One ls-tree call gives each file's mode, type and size; skip symlinks (120000), submodules and huge blobs.
  const listing = await git(repoDir, ["ls-tree", "-l", "-z", headSha, "--", ...wanted]);
  for (const entry of listing.split("\0")) {
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.+)$/s.exec(entry);
    if (!match) continue;
    const [, mode, type, , size, file] = match;
    if (type !== "blob" || mode === "120000") continue;
    if (size === "-" || Number(size) > MAX_FILE_BYTES) continue;
    out[file as string] = await git(repoDir, ["show", `${headSha}:${file}`]);
  }
  return out;
}
