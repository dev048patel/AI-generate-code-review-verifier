import { mkdir } from "node:fs/promises";
import { runProcess, scrubbedEnv } from "@acrv/mutation";

export interface CheckoutOptions {
  /** e.g. https://github.com/owner/repo.git (or a file:// URL in tests). */
  remoteUrl: string;
  dir: string;
  baseSha: string;
  headSha: string;
  /** Installation token. Sent as a per-command HTTP header and never written to .git/config. */
  token?: string;
  timeoutMs?: number;
}

async function git(cwd: string, args: string[], token: string | undefined, timeoutMs: number): Promise<string> {
  const auth = token
    ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
    : [];
  const { stdout } = await runProcess("git", [...auth, "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], cwd, timeoutMs, {
    acceptExitCode: (c) => c === 0,
    label: `git ${args[0]}`,
    env: scrubbedEnv(cwd, { GIT_TERMINAL_PROMPT: "0" }),
  });
  return stdout;
}

/**
 * Fetches exactly the PR's base and head commits (shallow), deepening until
 * their merge base is present so the diff matches what GitHub shows, then
 * checks out the head. The token lives only in the git processes' arguments:
 * the checked-out tree -- which the sandbox later executes -- never sees it.
 */
export async function checkoutPullRequest(options: CheckoutOptions): Promise<void> {
  const { remoteUrl, dir, baseSha, headSha, token, timeoutMs = 300_000 } = options;
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("base/head must be full commit SHAs");
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet"], undefined, timeoutMs);
  await git(dir, ["remote", "add", "origin", remoteUrl], undefined, timeoutMs);
  await git(dir, ["fetch", "--quiet", "--no-tags", "--depth=50", "origin", baseSha, headSha], token, timeoutMs);

  for (let depth = 100; ; depth *= 4) {
    try {
      await git(dir, ["merge-base", baseSha, headSha], undefined, timeoutMs);
      break;
    } catch {
      if (depth > 6400) break; // very divergent history: diff against the base tip instead
      await git(dir, ["fetch", "--quiet", "--no-tags", `--deepen=${depth}`, "origin", baseSha, headSha], token, timeoutMs);
    }
  }
  await git(dir, ["checkout", "--quiet", "--detach", headSha], undefined, timeoutMs);
}
