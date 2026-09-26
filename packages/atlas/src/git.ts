import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runProcess, scrubbedEnv } from "@acrv/mutation";
import { isCodeFile } from "./extract.js";

export const MAX_FILE_BYTES = 512 * 1024;
export const CODE_PATHSPECS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/** Runs git with hooks disabled and a scrubbed environment: repos analyzed here are untrusted. */
export async function git(repoDir: string, args: string[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<string> {
  const { stdout } = await runProcess("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args], repoDir, options.timeoutMs ?? 300_000, {
    acceptExitCode: (c) => c === 0,
    label: `git ${args[0]}`,
    env: scrubbedEnv(repoDir, { GIT_TERMINAL_PROMPT: "0" }),
    maxOutputBytes: options.maxOutputBytes ?? 256 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Streams blob contents through one long-lived `git cat-file --batch`
 * process -- orders of magnitude faster than a `git show` per file when
 * replaying hundreds of commits.
 */
export class BlobReader {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending: Array<{ resolve: (v: string | null) => void; reject: (e: Error) => void }> = [];
  private failed: Error | undefined;

  constructor(repoDir: string) {
    this.child = spawn("git", ["-c", "core.hooksPath=/dev/null", "cat-file", "--batch"], {
      cwd: repoDir,
      env: scrubbedEnv(repoDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const fail = (err: Error) => {
      this.failed = err;
      for (const p of this.pending.splice(0)) p.reject(err);
    };
    this.child.on("error", fail);
    this.child.on("close", (code) => {
      if (this.pending.length > 0) fail(new Error(`git cat-file exited with code ${code}`));
    });
  }

  read(sha: string): Promise<string | null> {
    if (this.failed) return Promise.reject(this.failed);
    if (!/^[0-9a-f]{7,64}$/.test(sha)) return Promise.reject(new Error(`bad object id ${sha}`));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${sha}\n`);
    });
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return;
      const header = this.buffer.subarray(0, nl).toString("utf-8");
      if (header.endsWith(" missing")) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.pending.shift()!.resolve(null);
        continue;
      }
      const size = Number(header.split(" ")[2]);
      if (this.buffer.length < nl + 1 + size + 1) return;
      const content = this.buffer.subarray(nl + 1, nl + 1 + size).toString("utf-8");
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.pending.shift()!.resolve(content);
    }
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  /** Message after the subject: trailers such as `Co-Authored-By:` live here. */
  body: string;
  /** 2+ for merge commits. */
  parents: number;
}

/** The newest `max` first-parent commits of `ref`, returned oldest first. */
export async function listCommits(repoDir: string, ref: string, max: number): Promise<CommitInfo[]> {
  // Fields split by \x1f, records ended by \x1e: bodies contain newlines.
  const out = await git(repoDir, ["log", "--first-parent", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b%x1e", "-n", String(max), ref, "--"]);
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, author, email, date, parents, subject, body] = r.split("\x1f");
      return {
        sha: sha!,
        author: author ?? "",
        email: email ?? "",
        date: date ?? "",
        subject: subject ?? "",
        body: (body ?? "").trim().slice(0, 4000),
        parents: (parents ?? "").split(" ").filter(Boolean).length,
      };
    })
    .reverse();
}

export interface TreeEntry {
  path: string;
  blob: string;
}

/** Code files at a commit (no symlinks, submodules, or oversized blobs). */
export async function listTree(repoDir: string, sha: string): Promise<{ entries: TreeEntry[]; skipped: number }> {
  const out = await git(repoDir, ["ls-tree", "-r", "-z", "--long", sha]);
  const entries: TreeEntry[] = [];
  let skipped = 0;
  for (const rec of out.split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) continue;
    const [, mode, type, blob, size, file] = m;
    if (type !== "blob" || mode === "120000" || !isCodeFile(file!)) continue;
    if (size === "-" || Number(size) > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    entries.push({ path: file!, blob: blob! });
  }
  return { entries, skipped };
}

export interface TreeChange {
  path: string;
  /** New blob id; undefined when the file was deleted (or is no longer a regular code file). */
  blob?: string;
}

/** Code files that changed between a commit and its first parent. */
export async function changedFiles(repoDir: string, parent: string, sha: string): Promise<TreeChange[]> {
  const out = await git(repoDir, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", parent, sha]);
  const tokens = out.split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    const file = tokens[i + 1]!;
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(meta);
    if (!m || !isCodeFile(file)) continue;
    const [, , newMode, , newBlob, status] = m;
    const deleted = status === "D" || newMode === "120000" || newMode === "160000";
    changes.push({ path: file, blob: deleted ? undefined : newBlob });
  }
  return changes;
}

export interface CommitPatch {
  sha: string;
  files: Array<{ path: string; added: string[]; deleted: string[] }>;
}

/**
 * Added/deleted lines per code file for each first-parent commit, from one
 * `git log -p -U0` call. Used for churn and for spotting code that was
 * written and thrown away again a few commits later.
 */
export async function commitPatches(repoDir: string, ref: string, max: number): Promise<Map<string, CommitPatch>> {
  const out = await git(repoDir, [
    "log", "--first-parent", "-p", "-U0", "--no-color", "--no-renames", "--no-ext-diff", "--format=%x00COMMIT %H",
    "-n", String(max), ref, "--", ...CODE_PATHSPECS,
  ]);
  const patches = new Map<string, CommitPatch>();
  for (const chunk of out.split("\0COMMIT ").slice(1)) {
    const nl = chunk.indexOf("\n");
    const sha = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    const patch: CommitPatch = { sha, files: [] };
    let current: CommitPatch["files"][number] | undefined;
    let inHunk = false;
    for (const line of chunk.slice(nl + 1).split("\n")) {
      if (line.startsWith("diff --git ")) {
        const m = / b\/(.+)$/.exec(line);
        current = m && isCodeFile(m[1]!) ? { path: m[1]!, added: [], deleted: [] } : undefined;
        if (current) patch.files.push(current);
        inHunk = false;
      } else if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk && current) {
        if (line.startsWith("+")) current.added.push(line.slice(1));
        else if (line.startsWith("-")) current.deleted.push(line.slice(1));
      }
    }
    patches.set(sha, patch);
  }
  return patches;
}

/** The commits a merge brought in (its second parent's side), for reading their trailers. */
export async function mergedCommits(repoDir: string, merge: string, max = 100): Promise<Array<Pick<CommitInfo, "author" | "email" | "subject" | "body">>> {
  try {
    const out = await git(repoDir, ["log", "--format=%an%x1f%ae%x1f%s%x1f%b%x1e", "-n", String(max), `${merge}^1..${merge}^2`, "--"]);
    return out
      .split("\x1e")
      .map((r) => r.replace(/^\n+/, ""))
      .filter(Boolean)
      .map((r) => {
        const [author, email, subject, body] = r.split("\x1f");
        return { author: author ?? "", email: email ?? "", subject: subject ?? "", body: (body ?? "").trim().slice(0, 4000) };
      });
  } catch {
    return []; // shallow clone: the branch side isn't there
  }
}
