import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteReviewStore, type ReviewStore } from "@acrv/core";
import { createLLMProvider, type LLMProvider } from "@acrv/llm";
import { createSandboxExecutor } from "@acrv/mutation";
import { AtlasService } from "./atlas/atlasService.js";
import { InMemorySessionStore, PostgresSessionStore, type SessionStore } from "./auth/sessions.js";
import { BudgetedProvider, InMemorySpendLedger, PostgresSpendLedger, type SpendLedger } from "./budget.js";
import { createPool, migrate } from "./db/migrate.js";
import { PostgresReviewStore } from "./db/PostgresReviewStore.js";
import { GitHubAppAuth, REVIEW_TOKEN_PERMISSIONS } from "./githubApp.js";
import { RestGitHubClient } from "./githubClient.js";
import { createApp } from "./httpApp.js";
import { createLogger, Metrics } from "./observability.js";
import { InMemoryJobQueue, type JobQueue } from "./queue/JobQueue.js";
import { PostgresJobQueue } from "./queue/PostgresJobQueue.js";
import { DeadLetterQueue } from "./reviewPipeline.js";
import { runWorkerLoop, type WorkerDeps } from "./worker.js";

export * from "./httpApp.js";
export * from "./githubClient.js";
export { renderReviewComment } from "@acrv/core";
export * from "./reviewPipeline.js";
export * from "./retry.js";
export * from "./verifyWebhookSignature.js";
export * from "./worker.js";
export * from "./queue/JobQueue.js";
export * from "./queue/PostgresJobQueue.js";
export * from "./budget.js";
export * from "./githubApp.js";

/**
 * Configuration (all environment variables):
 *   ACRV_ROLE                 web | worker | all (default all)
 *   ACRV_PRODUCTION=true      enforce webhook secret, sign-in, durable queue; disable demo endpoints
 *   DATABASE_URL              Postgres for reviews, queue, sessions, spend (else SQLite + in-memory, dev only)
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY   GitHub App auth (per-installation, per-repo tokens)
 *   GITHUB_WEBHOOK_SECRET     webhook HMAC secret
 *   GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, ACRV_PUBLIC_URL   dashboard sign-in
 *   GITHUB_TOKEN              fallback token when not running as an App (dev)
 *   LLM_PROVIDER              anthropic | bedrock | mock   (+ ANTHROPIC_API_KEY or AWS credentials)
 *   ACRV_MONTHLY_BUDGET_USD   LLM spend cap per account per month (default 50)
 *   ACRV_SANDBOX              docker | local | local-unsafe (see @acrv/mutation)
 *   ACRV_CHECK_FAIL_BELOW     check run fails below this trust score (default 0: never)
 *   ACRV_METRICS_TOKEN        bearer token for /metrics
 *   ACRV_TRACE_TOKEN          bearer token apps must send to POST /v1/traces (Repo Atlas live view)
 *   ACRV_ATLAS_API_TOKEN      bearer token the browser extension uses for Atlas read endpoints
 *   ACRV_ATLAS_MAX_COMMITS    history window for Repo Atlas (default 150)
 */
async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logger = createLogger({ service: "acrv" });
  const metrics = new Metrics();
  const role = env.ACRV_ROLE ?? "all";
  const production = env.ACRV_PRODUCTION === "true";
  const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const sandboxRoot = path.resolve(env.ACRV_SANDBOX_ROOT ?? path.join(repoRoot, "sandbox-runs"));
  await mkdir(sandboxRoot, { recursive: true });

  const pool = env.DATABASE_URL ? createPool(env.DATABASE_URL) : undefined;
  if (pool) await migrate(pool);
  else if (production) throw new Error("ACRV_PRODUCTION=true requires DATABASE_URL");

  const reviewStore: ReviewStore = pool
    ? new PostgresReviewStore(pool)
    : new SqliteReviewStore(env.ACRV_DB_PATH ?? path.join(repoRoot, "acrv-reviews.sqlite"));
  const queue: JobQueue = pool ? new PostgresJobQueue(pool) : new InMemoryJobQueue();
  const sessions: SessionStore = pool ? new PostgresSessionStore(pool) : new InMemorySessionStore();
  const ledger: SpendLedger = pool ? new PostgresSpendLedger(pool) : new InMemorySpendLedger();

  const baseProvider = createLLMProvider();
  const budget = Number(env.ACRV_MONTHLY_BUDGET_USD ?? 50);
  const providerFor = (account: string): LLMProvider =>
    baseProvider.name === "mock" ? baseProvider : new BudgetedProvider(baseProvider, ledger, account, budget);

  const executor = createSandboxExecutor(env);
  if (!executor.allowsUntrustedCode) {
    logger.warn("PR code will not be executed: set ACRV_SANDBOX=docker (see infra/sandbox) to enable tests and mutation testing");
  }
  if (production && executor.kind !== "docker") throw new Error("ACRV_PRODUCTION=true requires ACRV_SANDBOX=docker");

  const appAuth = GitHubAppAuth.fromEnv(env);
  const githubToken = env.GITHUB_TOKEN || undefined;
  if (production && !appAuth) throw new Error("ACRV_PRODUCTION=true requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");

  const abort = new AbortController();
  const stops: Array<() => Promise<void>> = [];

  if (role === "worker" || role === "all") {
    const workerDeps: WorkerDeps = {
      queue,
      reviewStore,
      sandboxRoot,
      executor,
      github: async (job) => {
        if (appAuth && job.installationId) {
          const token = await appAuth.installationToken({
            installationId: job.installationId,
            repository: job.repo,
            permissions: REVIEW_TOKEN_PERMISSIONS,
          });
          return { client: new RestGitHubClient(token), token };
        }
        return { client: new RestGitHubClient(githubToken), token: githubToken };
      },
      llmProviderFor: (job) => providerFor(job.owner),
      checkout: env.ACRV_REVIEW_MODE !== "diff",
      checkFailBelow: Number(env.ACRV_CHECK_FAIL_BELOW ?? 0),
      logger,
      metrics,
    };
    const loop = runWorkerLoop(workerDeps, { signal: abort.signal });
    stops.push(() => loop);
  }

  if (role === "web" || role === "all") {
    const oauth =
      env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET && env.ACRV_PUBLIC_URL
        ? { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET, publicUrl: env.ACRV_PUBLIC_URL }
        : undefined;
    if (!oauth) logger.warn("dashboard sign-in is not configured: the API is open -- only acceptable on localhost");
    const dashboardDir = env.ACRV_DASHBOARD_DIR ?? path.join(repoRoot, "packages/dashboard/dist");

    const atlas = new AtlasService({
      cacheDir: path.join(sandboxRoot, "atlas-cache"),
      maxCommits: Number(env.ACRV_ATLAS_MAX_COMMITS ?? 150),
      pullRefs: async (repo, prNumber) => {
        const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
          },
        });
        if (!res.ok) throw new Error(`GitHub PR lookup failed: ${res.status}`);
        const pr = (await res.json()) as { base: { sha: string }; head: { sha: string } };
        return { baseSha: pr.base.sha, headSha: pr.head.sha };
      },
    });

    const app = createApp({
      deps: { githubClient: new RestGitHubClient(githubToken), llmProvider: baseProvider, reviewStore, sandboxRoot, dlq: new DeadLetterQueue(), executor },
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      liveGithubToken: githubToken,
      queue,
      auth: oauth ? { sessions, oauth } : undefined,
      production,
      publicUrl: env.ACRV_PUBLIC_URL,
      llmProviderForAccount: providerFor,
      dashboardDir: existsSync(dashboardDir) ? dashboardDir : undefined,
      metrics,
      metricsToken: env.ACRV_METRICS_TOKEN,
      logger,
      atlas: { service: atlas, traceToken: env.ACRV_TRACE_TOKEN || undefined, apiToken: env.ACRV_ATLAS_API_TOKEN || undefined },
    });
    const port = Number(env.PORT ?? 3001);
    const server = app.listen(port, () => {
      logger.info("server listening", { port, role, production, llmProvider: baseProvider.name, sandbox: executor.kind, db: pool ? "postgres" : "sqlite" });
    });
    stops.push(() => new Promise((resolve) => server.close(() => resolve())));
  }

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    abort.abort();
    await Promise.allSettled(stops.map((s) => s()));
    await pool?.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
