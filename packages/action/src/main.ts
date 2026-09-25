import { existsSync } from "node:fs";
import path from "node:path";
import { renderReviewComment, type ReviewResult } from "@acrv/core";
import { createLLMProvider, type LLMProvider } from "@acrv/llm";
import { createSandboxExecutor } from "@acrv/mutation";
import { executeWorkspace, runWorkspaceReview, type WorkspaceExecution } from "@acrv/pipeline";
import { GitHubApi, readEvent, resolvePullRequest } from "./context.js";
import { readExecutionFile, writeExecutionFile } from "./executionFile.js";
import { annotationCommands, appendSummary, setOutput } from "./workflowCommands.js";

type Mode = "execute" | "report" | "all";

/**
 * GitHub Action entry point. Three modes, so untrusted code and secrets never
 * share a job:
 *
 *  - execute: runs the PR's code (generated tests + mutation testing against
 *    the project's own suite) in a job with NO secrets and a read-only token,
 *    then writes the results to a file for upload as an artifact.
 *  - report: never executes PR code. Reads the diff from git, runs the LLM
 *    (with secrets), folds in the execute job's results, and publishes the
 *    trust score as annotations, a job summary, and a PR comment.
 *  - all: both in one job -- only for repos where every PR author is trusted.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const mode = (env.ACRV_MODE ?? "all") as Mode;
  if (!["execute", "report", "all"].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
  const repoDir = path.resolve(env.GITHUB_WORKSPACE ?? process.cwd());
  const executionFile = path.resolve(repoDir, env.ACRV_EXECUTION_FILE ?? "acrv-execution.json");
  const api = new GitHubApi(env.ACRV_GITHUB_TOKEN || undefined);
  const event = await readEvent(env);

  if (mode === "execute") {
    if (env.ACRV_GITHUB_TOKEN || env.ANTHROPIC_API_KEY || env.AWS_SECRET_ACCESS_KEY) {
      throw new Error(
        "execute mode runs untrusted PR code and must not receive credentials; remove github-token / API keys from this job.",
      );
    }
    const pr = await resolvePullRequest({ event, api, repoFullName: env.GITHUB_REPOSITORY ?? "" });
    const execution = await executeWorkspace({
      repoDir,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      // The Actions VM is disposable and this job holds no secrets, so local execution is acceptable here;
      // set sandbox: docker for defense in depth.
      executor: createSandboxExecutor({ ...env, ACRV_SANDBOX: env.ACRV_SANDBOX || "local-unsafe" }),
      untrusted: true,
      skipMutation: env.ACRV_SKIP_MUTATION === "true",
    });
    await writeExecutionFile(executionFile, pr.prNumber, execution);
    appendSummary(renderExecutionSummary(execution), env);
    console.log(`[acrv] execution results written to ${executionFile}`);
    return;
  }

  let execution: WorkspaceExecution | undefined;
  let artifactPrNumber: number | undefined;
  if (mode === "report") {
    if (existsSync(executionFile)) {
      const file = await readExecutionFile(executionFile);
      execution = file.execution;
      artifactPrNumber = file.prNumber;
    } else {
      console.warn(`[acrv] no execution file at ${executionFile}; reporting static + LLM analysis only.`);
    }
  }

  const pr = await resolvePullRequest({ event, api, artifactPrNumber, repoFullName: env.GITHUB_REPOSITORY ?? "" });
  if (mode === "all" && pr.isFork) {
    console.warn("[acrv] mode=all on a fork PR: use the two-job execute/report setup so fork code never runs next to secrets.");
  }

  const llmProvider = selectProvider(env);
  const review = await runWorkspaceReview({
    repoDir,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    repo: `${pr.owner}/${pr.repo}`,
    prNumber: pr.prNumber,
    prTitle: pr.title,
    prDescription: pr.body,
    prUrl: pr.htmlUrl,
    prAuthor: pr.author,
    llmProvider,
    execution,
    execute: mode === "all",
    executor: mode === "all" ? createSandboxExecutor({ ...env, ACRV_SANDBOX: env.ACRV_SANDBOX || "local-unsafe" }) : undefined,
    untrusted: true,
    skipMutation: env.ACRV_SKIP_MUTATION === "true",
  });

  publish(review, { llmProvider, env });
  if (env.ACRV_COMMENT !== "false" && api.canWrite) {
    try {
      await api.upsertComment(pr.owner, pr.repo, pr.prNumber, "action-summary", renderReviewComment(review));
    } catch (err) {
      // A read-only token (fork PR on pull_request) can't comment; annotations and the summary still work.
      console.warn(`[acrv] could not post the PR comment: ${String(err).split("\n")[0]}`);
    }
  }

  const failBelow = Number(env.ACRV_FAIL_BELOW ?? "0");
  if (review.trustScore.score < failBelow) {
    console.error(`[acrv] trust score ${review.trustScore.score} is below fail-below=${failBelow}`);
    process.exitCode = 1;
  }
}

/** "auto": the Anthropic API if a key is present, Bedrock if explicitly asked, otherwise no LLM (rules + execution only). */
export function selectProvider(env: NodeJS.ProcessEnv): LLMProvider | undefined {
  const choice = env.ACRV_LLM_PROVIDER || "auto";
  if (choice === "none") return undefined;
  if (choice === "anthropic" || choice === "bedrock") return createLLMProvider({ provider: choice });
  if (choice === "auto") return env.ANTHROPIC_API_KEY ? createLLMProvider({ provider: "anthropic" }) : undefined;
  throw new Error(`Unknown llm-provider "${choice}" (expected auto, anthropic, bedrock, or none)`);
}

function publish(review: ReviewResult, ctx: { llmProvider?: LLMProvider; env: NodeJS.ProcessEnv }): void {
  for (const line of annotationCommands(review.trustScore.evidence)) console.log(line);
  const header = ctx.llmProvider ? "" : "> ℹ️ No LLM configured (set `ANTHROPIC_API_KEY`), so this review is rules + execution only.\n\n";
  appendSummary(header + renderReviewComment(review), ctx.env);
  setOutput("trust-score", String(review.trustScore.score), ctx.env);
  setOutput("label", review.trustScore.label, ctx.env);
  setOutput("review-json", JSON.stringify({ id: review.id, score: review.trustScore.score, label: review.trustScore.label }), ctx.env);
  console.log(`[acrv] trust score ${review.trustScore.score}/100 (${review.trustScore.label})`);
}

function renderExecutionSummary(e: WorkspaceExecution): string {
  const lines = ["### AI Code Review Verifier — execute phase", ""];
  if (e.execution.skippedReason) lines.push(`Skipped: ${e.execution.skippedReason}`);
  if (e.testRun) lines.push(`- Generated tests: ${e.testRun.passed}/${e.testRun.total} passed`);
  if (e.ownTestsMutation) {
    lines.push(`- Own-test mutation score on changed lines: ${e.ownTestsMutation.mutationScore}% (${e.ownTestsMutation.totalMutants} mutants)`);
  }
  for (const note of e.execution.notes ?? []) lines.push(`- ${note.replace(/[<>]/g, "")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::${String(err).replace(/\n/g, "%0A")}`);
    process.exitCode = 1;
  });
}
