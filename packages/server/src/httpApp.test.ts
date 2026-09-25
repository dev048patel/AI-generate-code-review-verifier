import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SqliteReviewStore, type ReviewStore } from "@acrv/core";
import { MockProvider } from "@acrv/llm";
import { InMemoryGitHubClient } from "./githubClient.js";
import { createApp } from "./httpApp.js";
import { DeadLetterQueue } from "./reviewPipeline.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const sandboxRoot = path.join(repoRoot, "sandbox-runs");

beforeAll(async () => {
  await mkdir(sandboxRoot, { recursive: true });
});

let reviewStore: ReviewStore | undefined;

afterEach(async () => {
  await reviewStore?.close();
  reviewStore = undefined;
});

function buildApp(evalReportPath?: string) {
  reviewStore = new SqliteReviewStore(":memory:");
  const githubClient = new InMemoryGitHubClient({
    "acme/widgets#1": {
      repo: "acme/widgets",
      prNumber: 1,
      headSha: "abc123",
      title: "Add clamp()",
      description: "",
      diffText: `diff --git a/calc.ts b/calc.ts
--- a/calc.ts
+++ b/calc.ts
@@ -1,3 +1,6 @@
+export function clamp(n: number, min: number, max: number): number {
+  if (n < min) return min;
+  return n;
+}
`,
      afterFileContents: {
        "calc.ts": `export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  return n;
}
`,
      },
    },
  });

  const app = createApp({
    deps: { githubClient, llmProvider: new MockProvider(), reviewStore, sandboxRoot, dlq: new DeadLetterQueue() },
    evalReportPath,
  });
  return { app, githubClient };
}

describe("createApp", () => {
  it("GET /healthz returns ok", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/simulate runs a review and returns it", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/simulate").send({ owner: "acme", repo: "widgets", prNumber: 1 });
    expect(res.status).toBe(200);
    expect(res.body.review.trustScore).toBeDefined();
  }, 30_000);

  it("POST /api/simulate returns 400 when fields are missing", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/simulate").send({ owner: "acme" });
    expect(res.status).toBe(400);
  });

  it("POST /api/simulate returns 502 for an unregistered PR", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/simulate").send({ owner: "acme", repo: "widgets", prNumber: 999 });
    expect(res.status).toBe(502);
  }, 15_000);

  it("GET /api/reviews lists a review after it's been simulated", async () => {
    const { app } = buildApp();
    await request(app).post("/api/simulate").send({ owner: "acme", repo: "widgets", prNumber: 1 });
    const res = await request(app).get("/api/reviews");
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
  }, 30_000);

  it("GET /api/reviews/:id returns 404 for an unknown id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/reviews/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("GET /api/reviews/:id returns the full review after simulation", async () => {
    const { app } = buildApp();
    const simRes = await request(app).post("/api/simulate").send({ owner: "acme", repo: "widgets", prNumber: 1 });
    const id = simRes.body.review.id;
    const res = await request(app).get(`/api/reviews/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.review.id).toBe(id);
  }, 30_000);

  it("GET /api/fixtures lists the eval-harness seeded-bug fixtures", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/fixtures");
    expect(res.status).toBe(200);
    expect(res.body.fixtures.length).toBeGreaterThan(5);
    expect(res.body.fixtures.some((f: { id: string }) => f.id === "off-by-one-modified")).toBe(true);
  });

  it("GET /api/fixtures/:id/diff returns a runnable diff for a known fixture", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/fixtures/off-by-one-modified/diff");
    expect(res.status).toBe(200);
    expect(res.body.diffText).toContain("diff --git");
    expect(res.body.afterFileContents).toHaveProperty("sumRange.ts");
  });

  it("POST /api/simulate-diff runs a review directly from a pasted diff", async () => {
    const { app } = buildApp();
    const fixtureRes = await request(app).get("/api/fixtures/wrong-operator-modified/diff");
    const res = await request(app)
      .post("/api/simulate-diff")
      .send({ repo: "demo/repo", ...fixtureRes.body });
    expect(res.status).toBe(200);
    expect(res.body.review.risk?.findings.length).toBeGreaterThan(0);
    // Pasted code is untrusted: with only the local executor it is analyzed but never run.
    expect(res.body.review.testRun).toBeUndefined();
    expect(res.body.review.execution.skippedReason).toMatch(/not executed/);
  }, 30_000);

  it("POST /api/fixtures/:id/review runs a bundled fixture as trusted code, tests included", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/fixtures/wrong-operator-modified/review");
    expect(res.status).toBe(200);
    expect(res.body.review.execution.skippedReason).toBeUndefined();
    expect(res.body.review.testRun.total).toBeGreaterThan(0);
  }, 60_000);

  it("POST /api/fixtures/:id/review 404s for an unknown fixture", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/fixtures/nope/review");
    expect(res.status).toBe(404);
  });

  it("GET /api/eval-report returns 404 when no report file exists", async () => {
    const { app } = buildApp("/nonexistent/path/eval-report.json");
    const res = await request(app).get("/api/eval-report");
    expect(res.status).toBe(404);
  });

  it("GET /api/eval-report returns the report when present", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "acrv-eval-"));
    const reportPath = path.join(tmpDir, "eval-report.json");
    await writeFile(reportPath, JSON.stringify({ hello: "report" }), "utf-8");
    const { app } = buildApp(reportPath);
    const res = await request(app).get("/api/eval-report");
    expect(res.status).toBe(200);
    expect(res.body.hello).toBe("report");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /webhooks/github acknowledges a relevant pull_request event", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/webhooks/github")
      .set("x-github-event", "pull_request")
      .send({
        action: "opened",
        pull_request: { number: 1 },
        repository: { owner: { login: "acme" }, name: "widgets" },
      });
    expect(res.status).toBe(202);
  });

  it("GET /api/live/:owner/:repo/pulls proxies real GitHub PR listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { number: 3, title: "Real PR", user: { login: "octocat" }, updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/acme/widgets/pull/3" },
        ],
      }),
    );
    const { app } = buildApp();
    const res = await request(app).get("/api/live/acme/widgets/pulls");
    expect(res.status).toBe(200);
    expect(res.body.pullRequests).toHaveLength(1);
    expect(res.body.pullRequests[0].number).toBe(3);
    vi.unstubAllGlobals();
  });

  it("GET /api/live/:owner/:repo/pulls returns a friendly 502 on GitHub failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "rate limited" }));
    const { app } = buildApp();
    const res = await request(app).get("/api/live/acme/widgets/pulls");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/rate limit/i);
    vi.unstubAllGlobals();
  });

  it("POST /api/live-review fetches a real PR and runs the full pipeline without posting a comment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/files")) {
          return { ok: true, json: async () => [{ filename: "calc.ts", status: "modified" }] };
        }
        if (url.includes("/contents/")) {
          return {
            ok: true,
            json: async () => ({
              content: Buffer.from("export function add(a: number, b: number) { return a + b; }\n").toString("base64"),
              encoding: "base64",
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ title: "Real PR", body: "", head: { sha: "deadbeef" }, user: { login: "octocat" }, html_url: "https://github.com/acme/widgets/pull/9" }),
          text: async () =>
            `diff --git a/calc.ts b/calc.ts\n--- a/calc.ts\n+++ b/calc.ts\n@@ -1 +1 @@\n-export function add(a, b) { return a + b; }\n+export function add(a: number, b: number) { return a + b; }\n`,
        };
      }),
    );

    const { app } = buildApp();
    const res = await request(app).post("/api/live-review").send({ owner: "acme", repo: "widgets", prNumber: 9 });
    expect(res.status).toBe(200);
    expect(res.body.review.isLive).toBe(true);
    expect(res.body.review.prUrl).toBe("https://github.com/acme/widgets/pull/9");
    vi.unstubAllGlobals();
  }, 30_000);

  it("POST /webhooks/github ignores irrelevant actions", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/webhooks/github")
      .set("x-github-event", "pull_request")
      .send({ action: "closed", pull_request: { number: 1 }, repository: { owner: { login: "acme" }, name: "widgets" } });
    expect(res.status).toBe(202);
  });
});
