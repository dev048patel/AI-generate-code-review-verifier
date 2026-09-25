import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { renderReviewComment, type ReviewResult, type ReviewStore } from "@acrv/core";
import type { LLMProvider } from "@acrv/llm";
import type { SandboxExecutor } from "@acrv/mutation";
import { runReview, runWorkspaceReview } from "@acrv/pipeline";
import { checkoutPullRequest } from "./checkout.js";
import { checkRunOutcome, type GitHubClient } from "./githubClient.js";
import type { Logger, Metrics } from "./observability.js";
import type { JobQueue, QueuedJob } from "./queue/JobQueue.js";
import { withRetry } from "./retry.js";

export interface JobGitHubAccess {
  client: GitHubClient;
  /** Installation token for cloning; absent for public repos / tests. */
  token?: string;
  /** Override the clone URL (tests use file:// remotes). */
  remoteUrl?: string;
}

export interface WorkerDeps {
  queue: JobQueue;
  reviewStore: ReviewStore;
  sandboxRoot: string;
  executor?: SandboxExecutor;
  github: (job: QueuedJob) => Promise<JobGitHubAccess>;
  llmProviderFor: (job: QueuedJob) => LLMProvider;
  /** true: review from a real checkout (production). false: review the fetched diff only (dev, in-memory GitHub). */
  checkout: boolean;
  /** Check run concludes "failure" below this score; 0 = never block merges. */
  checkFailBelow?: number;
  logger: Logger;
  metrics: Metrics;
}

export type JobOutcome = "published" | "superseded" | "failed";

const NETWORK_RETRY = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8000 };
const COMMENT_MARKER = "pr-summary";

/** Processes one claimed job end to end. Never throws: failures go back to the queue for retry / dead-lettering. */
export async function processQueuedJob(job: QueuedJob, deps: WorkerDeps): Promise<JobOutcome> {
  const log = (msg: string, fields: Record<string, unknown> = {}) =>
    deps.logger.info(msg, { jobId: job.id, repo: `${job.owner}/${job.repo}`, pr: job.prNumber, sha: job.headSha.slice(0, 7), ...fields });
  const started = Date.now();
  const heartbeat = setInterval(() => void deps.queue.heartbeat(job.id).catch(() => undefined), 30_000);
  let access: JobGitHubAccess | undefined;
  let checkRunId: number | undefined;

  try {
    access = await deps.github(job);
    const { client } = access;
    checkRunId = await client.createCheckRun?.(job.owner, job.repo, job.headSha).catch((err) => {
      deps.logger.warn("could not create check run", { jobId: job.id, err });
      return undefined;
    });

    const ctx = await withRetry(() => client.fetchPullRequest(job.owner, job.repo, job.prNumber), NETWORK_RETRY);
    if (ctx.headSha !== job.headSha) {
      return await supersede(job, deps, access, checkRunId, log);
    }

    let review: ReviewResult;
    if (deps.checkout && ctx.baseSha) {
      const dir = path.join(deps.sandboxRoot, `job-${job.id}-${randomUUID().slice(0, 8)}`);
      const repoDir = path.join(dir, "repo");
      try {
        await checkoutPullRequest({
          remoteUrl: access.remoteUrl ?? `https://github.com/${job.owner}/${job.repo}.git`,
          dir: repoDir,
          baseSha: ctx.baseSha,
          headSha: job.headSha,
          token: access.token,
        });
        review = await runWorkspaceReview({
          repoDir,
          workspaceDir: dir,
          baseSha: ctx.baseSha,
          headSha: job.headSha,
          repo: ctx.repo,
          prNumber: ctx.prNumber,
          prTitle: ctx.title,
          prDescription: ctx.description,
          prUrl: ctx.htmlUrl,
          prAuthor: ctx.authorLogin,
          llmProvider: deps.llmProviderFor(job),
          executor: deps.executor,
          untrusted: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      review = await runReview({
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        headSha: ctx.headSha,
        prTitle: ctx.title,
        prDescription: ctx.description,
        diffText: ctx.diffText,
        afterFileContents: ctx.afterFileContents,
        llmProvider: deps.llmProviderFor(job),
        sandboxRoot: deps.sandboxRoot,
        executor: deps.executor,
        untrusted: true,
        prUrl: ctx.htmlUrl,
        prAuthor: ctx.authorLogin,
        isLive: true,
      });
    }

    await deps.reviewStore.put(review);
    // A newer commit may have arrived while this one was being reviewed: don't overwrite its result.
    if (await deps.queue.isSuperseded(job)) {
      return await supersede(job, deps, access, checkRunId, log);
    }

    const body = renderReviewComment(review);
    await withRetry(() => client.upsertComment(job.owner, job.repo, job.prNumber, COMMENT_MARKER, body), NETWORK_RETRY);
    if (checkRunId !== undefined) {
      await client.completeCheckRun?.(job.owner, job.repo, checkRunId, checkRunOutcome(review, body, deps.checkFailBelow));
    }
    await deps.queue.complete(job.id, review.id);

    deps.metrics.inc("acrv_reviews_total", { outcome: "published", label: review.trustScore.label });
    deps.metrics.inc("acrv_review_seconds_sum", {}, (Date.now() - started) / 1000);
    deps.metrics.inc("acrv_llm_cost_usd_total", {}, review.costUsd);
    log("review published", { reviewId: review.id, score: review.trustScore.score, ms: Date.now() - started, costUsd: review.costUsd });
    return "published";
  } catch (err) {
    await deps.queue.fail(job.id, err).catch(() => undefined);
    if (checkRunId !== undefined) {
      await access?.client
        .completeCheckRun?.(job.owner, job.repo, checkRunId, {
          conclusion: "neutral",
          title: "Review could not complete",
          summary: "The reviewer hit an error on this attempt; it will be retried automatically.",
        })
        .catch(() => undefined);
    }
    deps.metrics.inc("acrv_reviews_total", { outcome: "failed" });
    deps.logger.error("review failed", { jobId: job.id, attempts: job.attempts, err });
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}

async function supersede(
  job: QueuedJob,
  deps: WorkerDeps,
  access: JobGitHubAccess,
  checkRunId: number | undefined,
  log: (msg: string) => void,
): Promise<JobOutcome> {
  if (checkRunId !== undefined) {
    await access.client
      .completeCheckRun?.(job.owner, job.repo, checkRunId, {
        conclusion: "skipped",
        title: "Superseded by a newer commit",
        summary: "A newer commit was pushed to this pull request; it gets its own review.",
      })
      .catch(() => undefined);
  }
  await deps.queue.complete(job.id);
  deps.metrics.inc("acrv_reviews_total", { outcome: "superseded" });
  log("superseded by a newer commit");
  return "superseded";
}

export interface WorkerLoopOptions {
  workerId?: string;
  pollMs?: number;
  /** A running job whose heartbeat is older than this is presumed dead and requeued. */
  staleAfterMs?: number;
  signal?: AbortSignal;
}

/** Claims and processes jobs until the signal aborts. Run several processes for more throughput. */
export async function runWorkerLoop(deps: WorkerDeps, options: WorkerLoopOptions = {}): Promise<void> {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 6)}`;
  const pollMs = options.pollMs ?? 2000;
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
  let lastRecovery = 0;
  deps.logger.info("worker started", { workerId });

  while (!options.signal?.aborted) {
    try {
      if (Date.now() - lastRecovery > 60_000) {
        const recovered = await deps.queue.recoverStale(staleAfterMs);
        if (recovered > 0) deps.logger.warn("requeued stale jobs", { recovered });
        lastRecovery = Date.now();
      }
      const job = await deps.queue.claim(workerId);
      if (job) {
        await processQueuedJob(job, deps);
        continue;
      }
    } catch (err) {
      deps.logger.error("worker loop error", { err });
    }
    await sleep(pollMs, options.signal);
  }
  deps.logger.info("worker stopped", { workerId });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
