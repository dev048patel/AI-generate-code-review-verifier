import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewResult, ReviewStore } from "@acrv/core";
import { buildDiffFromFiles, loadFixtures, readFixtureFileContents } from "@acrv/eval-harness";
import type { LLMProvider } from "@acrv/llm";
import { runReview } from "@acrv/pipeline";
import {
  loadSession,
  mountGitHubOAuth,
  requireSameOrigin,
  requireSession,
  type AuthedRequest,
  type OAuthConfig,
} from "./auth/githubOAuth.js";
import type { SessionStore } from "./auth/sessions.js";
import { mountAtlas } from "./atlas/atlasRoutes.js";
import type { AtlasService } from "./atlas/atlasService.js";
import { listOpenPullRequests, RestGitHubClient, type GitHubClient } from "./githubClient.js";
import type { Logger, Metrics } from "./observability.js";
import type { JobQueue } from "./queue/JobQueue.js";
import { RateLimiter } from "./rateLimit.js";
import { DeadLetterQueue, processReviewJob, type ReviewPipelineDeps } from "./reviewPipeline.js";
import { verifyWebhookSignature } from "./verifyWebhookSignature.js";

export interface CreateAppOptions {
  deps: ReviewPipelineDeps;
  webhookSecret?: string;
  evalReportPath?: string;
  /**
   * Token used ONLY by the read-only "Live GitHub" endpoints below
   * (listing/fetching real public PRs), independent of `deps.githubClient`
   * (which drives the webhook/simulate flows and may be a test double).
   * Optional -- public repos work fine unauthenticated, just at a lower
   * GitHub rate limit.
   */
  liveGithubToken?: string;
  /** Durable queue for webhook-triggered reviews. Without one, webhooks are processed in-process (local dev only). */
  queue?: JobQueue;
  /** Dashboard sign-in. Without it the API is open -- acceptable only on localhost. */
  auth?: { sessions: SessionStore; oauth?: OAuthConfig; fetchImpl?: typeof fetch };
  /**
   * Production mode: webhook signatures and sign-in are mandatory, demo
   * endpoints (fixtures, simulate) are off, and live reviews are limited to
   * the signed-in user's own repos.
   */
  production?: boolean;
  /** Public origin (e.g. https://acrv.example.com) for CSRF checks and CORS. */
  publicUrl?: string;
  /** Wraps the LLM provider per account (e.g. with a monthly budget) for on-demand live reviews. */
  llmProviderForAccount?: (account: string) => LLMProvider;
  /** Built dashboard to serve from the same origin (packages/dashboard/dist). */
  dashboardDir?: string;
  metrics?: Metrics;
  metricsToken?: string;
  logger?: Logger;
  /** Repo Atlas: repo maps, history, PR impact and live traces. */
  atlas?: { service: AtlasService; traceToken?: string; apiToken?: string };
}

interface RequestWithRawBody extends AuthedRequest {
  rawBody?: Buffer;
}

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/** Builds the Express app: the GitHub webhook receiver plus the REST API the dashboard reads from. */
export function createApp(options: CreateAppOptions): Express {
  const { deps, webhookSecret, production = false } = options;
  if (production) {
    if (!webhookSecret) throw new Error("Production mode requires GITHUB_WEBHOOK_SECRET");
    if (!options.auth?.oauth || !options.publicUrl) throw new Error("Production mode requires GitHub OAuth and ACRV_PUBLIC_URL");
    if (!options.queue) throw new Error("Production mode requires a durable queue (DATABASE_URL)");
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // Same-origin in production (the dashboard is served from here); open CORS only for local dev.
  if (!production) app.use(cors());
  app.use(
    express.json({
      limit: "25mb", // GitHub webhook payloads can be large
      verify: (req: RequestWithRawBody, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  const auth = options.auth;
  if (auth) {
    app.use(loadSession(auth.sessions));
    if (auth.oauth) mountGitHubOAuth(app, auth.oauth, auth.sessions, auth.fetchImpl);
  }
  if (options.publicUrl) app.use("/api", requireSameOrigin(options.publicUrl));
  const signedIn = auth ? requireSession : (_req: Request, _res: Response, next: NextFunction) => next();
  const canSee = (req: AuthedRequest, repo: string) => !auth || Boolean(req.session?.repos.includes(repo));
  const demoOnly = (_req: Request, res: Response, next: NextFunction) =>
    production ? res.status(404).json({ error: "Not available in production mode" }) : next();
  const expensive = new RateLimiter(10, 10 / 60); // 10 burst, then 10 per hour
  const limitExpensive = expensive.middleware((req: AuthedRequest) => req.session?.login ?? req.ip ?? "anon");

  app.post("/webhooks/github", async (req: RequestWithRawBody, res) => {
    if (webhookSecret) {
      const signature = req.header("x-hub-signature-256");
      const valid = verifyWebhookSignature(req.rawBody?.toString("utf-8") ?? "", signature, webhookSecret);
      if (!valid) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }
    }

    const event = req.header("x-github-event");
    const payload = req.body as {
      action?: string;
      installation?: { id: number };
      pull_request?: { number: number; draft?: boolean; head?: { sha: string } };
      repository?: { owner: { login: string }; name: string };
    };

    const pr = payload.pull_request;
    if (event !== "pull_request" || !payload.action || !REVIEW_ACTIONS.has(payload.action) || !pr || !payload.repository) {
      res.status(202).json({ received: true, queued: false });
      return;
    }
    const job = { owner: payload.repository.owner.login, repo: payload.repository.name, prNumber: pr.number };

    if (options.queue) {
      if (!pr.head?.sha) {
        res.status(400).json({ error: "pull_request.head.sha missing" });
        return;
      }
      try {
        const result = await options.queue.enqueue(
          { ...job, headSha: pr.head.sha, installationId: payload.installation?.id },
          req.header("x-github-delivery") ?? undefined,
        );
        options.metrics?.inc("acrv_webhooks_total", { outcome: result.enqueued ? "enqueued" : (result.reason ?? "ignored") });
        res.status(202).json({ received: true, queued: result.enqueued, reason: result.reason });
      } catch (err) {
        // 5xx makes GitHub redeliver, and delivery-id dedupe makes that safe.
        options.logger?.error("enqueue failed", { err });
        res.status(503).json({ error: "queue unavailable" });
      }
      return;
    }

    // Local dev without a database: acknowledge immediately and process in the background.
    processReviewJob(job, deps).catch(() => {
      /* already recorded in the DLQ by processReviewJob */
    });
    res.status(202).json({ received: true, queued: true });
  });

  app.get("/auth/me", (req: AuthedRequest, res) => {
    if (!auth) {
      res.json({ login: null, authRequired: false, demoEndpoints: !production });
      return;
    }
    if (!req.session) {
      res.status(401).json({ error: "Sign in required", loginUrl: "/auth/login" });
      return;
    }
    res.json({ login: req.session.login, repoCount: req.session.repos.length, authRequired: true, demoEndpoints: !production });
  });

  app.get("/api/reviews", signedIn, async (req: AuthedRequest, res) => {
    const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
    const limit = req.query.limit ? Math.min(200, Number(req.query.limit) || 50) : 50;
    let reviews: ReviewResult[];
    if (repo) {
      reviews = canSee(req, repo) ? await deps.reviewStore.listByRepo(repo, limit) : [];
    } else {
      reviews = auth ? await deps.reviewStore.listForRepos(req.session!.repos, limit) : await deps.reviewStore.listRecent(limit);
    }
    res.json({ reviews });
  });

  app.get("/api/reviews/:id", signedIn, async (req: AuthedRequest, res) => {
    const review = await deps.reviewStore.get(req.params.id!);
    // 404 rather than 403, so review ids for other people's repos aren't confirmable.
    if (!review || !canSee(req, review.repo)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ review });
  });

  app.get("/api/dlq", signedIn, async (req: AuthedRequest, res) => {
    const legacy = deps.dlq.list();
    const failed = options.queue ? await options.queue.listFailed(100) : [];
    res.json({
      items: legacy.filter((i) => canSee(req, `${i.job.owner}/${i.job.repo}`)),
      failedJobs: failed.filter((j) => canSee(req, `${j.owner}/${j.repo}`)),
    });
  });

  app.post("/api/simulate", demoOnly, async (req, res) => {
    const { owner, repo, prNumber } = req.body as { owner?: string; repo?: string; prNumber?: number };
    if (!owner || !repo || typeof prNumber !== "number") {
      res.status(400).json({ error: "owner, repo, and prNumber are required" });
      return;
    }
    try {
      const review = await processReviewJob({ owner, repo, prNumber }, deps);
      res.json({ review });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  app.post("/api/simulate-diff", demoOnly, async (req, res) => {
    const body = req.body as {
      repo?: string;
      prTitle?: string;
      prDescription?: string;
      diffText?: string;
      afterFileContents?: Record<string, string>;
    };
    if (!body.repo || !body.diffText || !body.afterFileContents) {
      res.status(400).json({ error: "repo, diffText, and afterFileContents are required" });
      return;
    }
    try {
      const review = await runReview({
        repo: body.repo,
        prNumber: 0,
        headSha: "simulated",
        prTitle: body.prTitle ?? "Simulated PR",
        prDescription: body.prDescription ?? "",
        diffText: body.diffText,
        afterFileContents: body.afterFileContents,
        llmProvider: deps.llmProvider,
        sandboxRoot: deps.sandboxRoot,
        executor: deps.executor,
        // Pasted code is arbitrary code.
        untrusted: true,
      });
      await deps.reviewStore.put(review);
      res.json({ review });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  app.get("/api/fixtures", demoOnly, async (_req, res) => {
    const fixtures = await loadFixtures();
    res.json({
      fixtures: fixtures.map((f) => ({
        id: f.id,
        prTitle: f.meta.prTitle,
        isCleanControl: f.meta.isCleanControl,
        categories: [...new Set(f.meta.seededBugs.map((b) => b.category))],
      })),
    });
  });

  app.get("/api/fixtures/:id/diff", demoOnly, async (req, res) => {
    const fixtures = await loadFixtures();
    const fixture = fixtures.find((f) => f.id === req.params.id);
    if (!fixture) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { before, after } = await readFixtureFileContents(fixture);
    const changes = fixture.meta.files.map((f) => ({ path: f, before: before[f] ?? null, after: after[f] ?? null }));
    const diffText = buildDiffFromFiles(changes);
    const afterFileContents: Record<string, string> = {};
    for (const f of fixture.meta.files) {
      if (after[f] !== null) afterFileContents[f] = after[f] as string;
    }
    res.json({ prTitle: fixture.meta.prTitle, prDescription: fixture.meta.prDescription, diffText, afterFileContents });
  });

  // Fixtures ship with this repo, so their code is trusted and may run
  // under the local executor -- unlike /api/simulate-diff, whose body is
  // arbitrary caller-supplied code.
  app.post("/api/fixtures/:id/review", demoOnly, async (req, res) => {
    const fixtures = await loadFixtures();
    const fixture = fixtures.find((f) => f.id === req.params.id);
    if (!fixture) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const { before, after } = await readFixtureFileContents(fixture);
      const diffText = buildDiffFromFiles(
        fixture.meta.files.map((f) => ({ path: f, before: before[f] ?? null, after: after[f] ?? null })),
      );
      const afterFileContents: Record<string, string> = {};
      for (const f of fixture.meta.files) {
        if (after[f] !== null) afterFileContents[f] = after[f] as string;
      }
      const review = await runReview({
        repo: `fixtures/${fixture.id}`,
        prNumber: 0,
        headSha: fixture.id,
        prTitle: fixture.meta.prTitle,
        prDescription: fixture.meta.prDescription,
        diffText,
        afterFileContents,
        llmProvider: deps.llmProvider,
        sandboxRoot: deps.sandboxRoot,
      });
      await deps.reviewStore.put(review);
      res.json({ review });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  const liveGithub = new RestGitHubClient(options.liveGithubToken);

  app.get("/api/live/:owner/:repo/pulls", signedIn, async (req: AuthedRequest, res) => {
    if (production && !canSee(req, `${req.params.owner}/${req.params.repo}`)) {
      res.status(404).json({ error: "Repo not found among your installations" });
      return;
    }
    try {
      const prs = await listOpenPullRequests(req.params.owner!, req.params.repo!, options.liveGithubToken);
      res.json({ pullRequests: prs });
    } catch (err) {
      res.status(502).json({ error: describeGithubError(err) });
    }
  });

  app.post("/api/live-review", signedIn, limitExpensive, async (req: AuthedRequest, res) => {
    const { owner, repo, prNumber } = req.body as { owner?: string; repo?: string; prNumber?: number };
    if (!owner || !repo || typeof prNumber !== "number") {
      res.status(400).json({ error: "owner, repo, and prNumber are required" });
      return;
    }
    // In production, on-demand reviews are for your own repos -- they spend your account's LLM budget.
    if (production && !canSee(req, `${owner}/${repo}`)) {
      res.status(404).json({ error: "Repo not found among your installations" });
      return;
    }
    try {
      // Read-only: fetches the real diff and runs the pipeline, but never
      // posts a comment back to the real repo -- that only happens via the
      // webhook flow, and only with an explicitly configured write token.
      const ctx = await liveGithub.fetchPullRequest(owner, repo, prNumber);
      const review = await runReview({
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        headSha: ctx.headSha,
        prTitle: ctx.title,
        prDescription: ctx.description,
        diffText: ctx.diffText,
        afterFileContents: ctx.afterFileContents,
        llmProvider: options.llmProviderForAccount?.(owner) ?? deps.llmProvider,
        sandboxRoot: deps.sandboxRoot,
        executor: deps.executor,
        untrusted: true,
        prUrl: ctx.htmlUrl,
        prAuthor: ctx.authorLogin,
        isLive: true,
      });
      await deps.reviewStore.put(review);
      res.json({ review });
    } catch (err) {
      res.status(502).json({ error: describeGithubError(err) });
    }
  });

  if (options.atlas) {
    if (production && !options.atlas.traceToken) throw new Error("Production mode requires ACRV_TRACE_TOKEN for /v1/traces");
    mountAtlas(app, { ...options.atlas, signedIn, limitExpensive });
  }

  app.get("/api/eval-report", async (_req, res) => {
    try {
      const path = options.evalReportPath ?? new URL("../../eval-harness/output/eval-report.json", import.meta.url);
      const raw = await readFile(path, "utf-8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ error: "No evaluation report found. Run `npm run eval` first." });
    }
  });

  app.get("/metrics", (req, res) => {
    if (!options.metrics) {
      res.status(404).end();
      return;
    }
    if (options.metricsToken && req.header("authorization") !== `Bearer ${options.metricsToken}`) {
      res.status(401).end();
      return;
    }
    res.type("text/plain; version=0.0.4").send(options.metrics.render());
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  if (options.dashboardDir && existsSync(options.dashboardDir)) {
    const dir = path.resolve(options.dashboardDir);
    app.use(express.static(dir, { index: false, maxAge: "1h" }));
    // SPA fallback for client-side routes.
    app.get(/^\/(?!api\/|auth\/|webhooks\/|v1\/|metrics|healthz).*/, (_req, res) => res.sendFile(path.join(dir, "index.html")));
  }

  return app;
}

function describeGithubError(err: unknown): string {
  const message = String(err);
  if (message.includes("403")) {
    return "GitHub API rate limit likely exceeded (60 requests/hour unauthenticated). Set GITHUB_TOKEN on the server for a much higher limit.";
  }
  if (message.includes("404")) {
    return "Repo or PR not found -- check the owner/repo/PR number, and that the repo is public (or GITHUB_TOKEN has access).";
  }
  return message;
}

export { DeadLetterQueue };
export type { ReviewPipelineDeps, GitHubClient, ReviewStore };
