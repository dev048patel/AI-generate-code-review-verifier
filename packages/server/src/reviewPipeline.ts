import type { ReviewResult, ReviewStore } from "@acrv/core";
import type { LLMProvider } from "@acrv/llm";
import type { SandboxExecutor } from "@acrv/mutation";
import { runReview } from "@acrv/pipeline";
import type { GitHubClient } from "./githubClient.js";
import { renderReviewComment } from "@acrv/core";
import { RetryExhaustedError, withRetry } from "./retry.js";

export interface ReviewJob {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface FailedReview {
  job: ReviewJob;
  error: string;
  failedAt: string;
}

/** In-memory dead-letter queue for reviews that exhausted retries -- surfaced on the ops dashboard. */
export class DeadLetterQueue {
  private items: FailedReview[] = [];

  add(job: ReviewJob, error: unknown): void {
    this.items.push({ job, error: String(error), failedAt: new Date().toISOString() });
  }

  list(): FailedReview[] {
    return [...this.items];
  }
}

export interface ReviewPipelineDeps {
  githubClient: GitHubClient;
  llmProvider: LLMProvider;
  reviewStore: ReviewStore;
  sandboxRoot: string;
  dlq: DeadLetterQueue;
  /** Where PR code executes. Real PRs are untrusted: without an executor that allows untrusted code, execution is skipped. */
  executor?: SandboxExecutor;
}

const NETWORK_RETRY = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8000 };

/**
 * Processes one PR review end to end: fetch the diff (retried; GETs are
 * idempotent), run the pipeline, persist the result, and post/update the PR
 * comment (retried; upsertComment is idempotent by review id). Any failure
 * after retries are exhausted lands in the DLQ instead of being silently
 * dropped or endlessly retried against a possibly-broken PR.
 */
export async function processReviewJob(job: ReviewJob, deps: ReviewPipelineDeps): Promise<ReviewResult> {
  try {
    const ctx = await withRetry(
      () => deps.githubClient.fetchPullRequest(job.owner, job.repo, job.prNumber),
      NETWORK_RETRY,
    );

    const review = await runReview({
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      headSha: ctx.headSha,
      prTitle: ctx.title,
      prDescription: ctx.description,
      diffText: ctx.diffText,
      afterFileContents: ctx.afterFileContents,
      llmProvider: deps.llmProvider,
      sandboxRoot: deps.sandboxRoot,
      executor: deps.executor,
      untrusted: true,
      prUrl: ctx.htmlUrl,
      prAuthor: ctx.authorLogin,
    });

    await deps.reviewStore.put(review);

    await withRetry(
      () => deps.githubClient.upsertComment(job.owner, job.repo, job.prNumber, review.id, renderReviewComment(review)),
      NETWORK_RETRY,
    );

    return review;
  } catch (err) {
    deps.dlq.add(job, err instanceof RetryExhaustedError ? err.lastError : err);
    throw err;
  }
}
