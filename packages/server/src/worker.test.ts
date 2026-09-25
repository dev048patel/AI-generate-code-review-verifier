import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteReviewStore } from "@acrv/core";
import { MockProvider } from "@acrv/llm";
import { LocalProcessExecutor } from "@acrv/mutation";
import { checkoutPullRequest } from "./checkout.js";
import { InMemoryGitHubClient, type PullRequestContext } from "./githubClient.js";
import { createLogger, Metrics } from "./observability.js";
import { InMemoryJobQueue } from "./queue/JobQueue.js";
import { processQueuedJob, type WorkerDeps } from "./worker.js";

let root: string;
let store: SqliteReviewStore;
const silent = createLogger({}, () => undefined);

const DIFF = `diff --git a/pay.ts b/pay.ts
--- a/pay.ts
+++ b/pay.ts
@@ -1,1 +1,3 @@
+export function split(total: number, people: number): number {
+  return total / people;
+}
`;
const PAY = "export function split(total: number, people: number): number {\n  return total / people;\n}\n";

function pr(headSha: string, extra: Partial<PullRequestContext> = {}): PullRequestContext {
  return { repo: "acme/api", prNumber: 5, headSha, title: "Add split", description: "", diffText: DIFF, afterFileContents: { "pay.ts": PAY }, ...extra };
}

function deps(github: InMemoryGitHubClient, queue: InMemoryJobQueue, extra: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    queue,
    reviewStore: store,
    sandboxRoot: root,
    github: async () => ({ client: github }),
    llmProviderFor: () => new MockProvider(),
    checkout: false,
    logger: silent,
    metrics: new Metrics(),
    ...extra,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acrv-worker-"));
  store = new SqliteReviewStore(":memory:");
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe("processQueuedJob", () => {
  it("reviews, stores, comments once per PR, and completes a check run with annotations", async () => {
    const github = new InMemoryGitHubClient({ "acme/api#5": pr("a".repeat(40)) });
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ owner: "acme", repo: "api", prNumber: 5, headSha: "a".repeat(40) });

    expect(await processQueuedJob((await queue.claim("w"))!, deps(github, queue))).toBe("published");
    expect(github.postedComments).toHaveLength(1);
    expect(github.checkRuns[0]!.outcome?.title).toMatch(/Trust score \d+\/100/);
    expect(github.checkRuns[0]!.outcome?.findings?.some((f) => /division/i.test(f.title))).toBe(true);
    expect(queue.all()[0]!.status).toBe("done");
    expect(await store.listRecent()).toHaveLength(1);
    // Untrusted PR + local executor: code wasn't run, and the review says so.
    expect((await store.listRecent())[0]!.execution?.skippedReason).toMatch(/not executed/);

    // Next push: same comment is updated, not duplicated.
    github["pullRequests"]["acme/api#5"] = pr("b".repeat(40));
    await queue.enqueue({ owner: "acme", repo: "api", prNumber: 5, headSha: "b".repeat(40) });
    await processQueuedJob((await queue.claim("w"))!, deps(github, queue));
    expect(github.postedComments).toHaveLength(1);
  }, 30_000);

  it("fails the check only below the configured threshold", async () => {
    const github = new InMemoryGitHubClient({ "acme/api#5": pr("a".repeat(40)) });
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ owner: "acme", repo: "api", prNumber: 5, headSha: "a".repeat(40) });
    await processQueuedJob((await queue.claim("w"))!, deps(github, queue, { checkFailBelow: 101 }));
    expect(github.checkRuns[0]!.outcome?.conclusion).toBe("failure");
  }, 30_000);

  it("skips publishing when the PR has already moved to a newer commit", async () => {
    const github = new InMemoryGitHubClient({ "acme/api#5": pr("c".repeat(40)) });
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ owner: "acme", repo: "api", prNumber: 5, headSha: "a".repeat(40) });
    expect(await processQueuedJob((await queue.claim("w"))!, deps(github, queue))).toBe("superseded");
    expect(github.postedComments).toHaveLength(0);
    expect(github.checkRuns[0]!.outcome?.conclusion).toBe("skipped");
  });

  it("returns a failed job to the queue and marks the check neutral", async () => {
    const github = new InMemoryGitHubClient({});
    const queue = new InMemoryJobQueue(Date.now, () => 0);
    await queue.enqueue({ owner: "acme", repo: "api", prNumber: 404, headSha: "a".repeat(40) });
    const job = (await queue.claim("w"))!;
    expect(await processQueuedJob(job, deps(github, queue))).toBe("failed");
    expect(queue.all()[0]).toMatchObject({ status: "queued", lastError: expect.stringContaining("No fixture") });
    expect(github.checkRuns[0]!.outcome?.conclusion).toBe("neutral");
  }, 60_000);
});

describe("checkout mode", () => {
  let remote: string;
  let base: string;
  let head: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" }).trim();
  }

  beforeEach(async () => {
    remote = path.join(root, "remote");
    await mkdir(path.join(remote, "src", "util"), { recursive: true });
    git(remote, "init", "-q", "-b", "main");
    git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    await writeFile(path.join(remote, "package.json"), JSON.stringify({ name: "api", type: "module" }));
    await writeFile(path.join(remote, "src", "util", "half.ts"), "export const half = (n: number): number => n / 2;\n");
    git(remote, "add", ".");
    git(remote, "commit", "-qm", "base");
    base = git(remote, "rev-parse", "HEAD");
    await writeFile(
      path.join(remote, "src", "pay.ts"),
      'import { half } from "./util/half";\nexport function split(total: number, people: number): number {\n  return half(total) / people;\n}\n',
    );
    git(remote, "add", ".");
    git(remote, "commit", "-qm", "head");
    head = git(remote, "rev-parse", "HEAD");
  });

  it("fetches exactly base and head and never writes the token to .git/config", async () => {
    const dir = path.join(root, "co");
    await checkoutPullRequest({ remoteUrl: `file://${remote}`, dir, baseSha: base, headSha: head, token: "ghs_SECRET" });
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(dir, ".git", "config"), "utf-8")).not.toContain("ghs_SECRET");
    expect(git(dir, "merge-base", base, head)).toBe(base);
  });

  it("runs the full checkout review with an executor that may run untrusted code", async () => {
    const github = new InMemoryGitHubClient({ "acme/api#5": pr(head, { baseSha: base }) });
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ owner: "acme", repo: "api", prNumber: 5, headSha: head });
    const outcome = await processQueuedJob(
      (await queue.claim("w"))!,
      deps(github, queue, {
        checkout: true,
        executor: new LocalProcessExecutor({ allowUntrustedCode: true }),
        github: async () => ({ client: github, remoteUrl: `file://${remote}` }),
      }),
    );
    expect(outcome).toBe("published");
    const [review] = await store.listRecent();
    expect(review!.testRun?.total).toBeGreaterThan(0);
    // The generated test imported ./util/half from the real checkout.
    expect(review!.testRun?.failures.some((f) => /Cannot find|Failed to load/.test(f.message))).toBe(false);
  }, 60_000);
});
