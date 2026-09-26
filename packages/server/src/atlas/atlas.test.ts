import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteReviewStore } from "@acrv/core";
import { MockProvider } from "@acrv/llm";
import { InMemoryGitHubClient } from "../githubClient.js";
import { createApp } from "../httpApp.js";
import { DeadLetterQueue } from "../reviewPipeline.js";
import { AtlasService } from "./atlasService.js";

let root: string;
let remote: string;
let store: SqliteReviewStore;
const shas: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" }).trim();
}

async function commit(files: Record<string, string>, subject: string): Promise<string> {
  for (const [f, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(remote, f)), { recursive: true });
    await writeFile(path.join(remote, f), c);
  }
  git(remote, "add", "-A");
  git(remote, "commit", "-qm", subject);
  return git(remote, "rev-parse", "HEAD");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acrv-atlas-srv-"));
  remote = path.join(root, "remote");
  await mkdir(remote);
  git(remote, "init", "-q", "-b", "main");
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  shas.length = 0;
  shas.push(await commit({ "src/app.ts": `app.use(rateLimit()); app.post("/login", h); app.get("/health", h);` }, "init"));
  shas.push(await commit({ "src/app.ts": `app.post("/login", h); app.get("/health", h);` }, "remove limiter"));
  store = new SqliteReviewStore(":memory:");
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

function service() {
  return new AtlasService({
    cacheDir: path.join(root, "cache"),
    remoteUrl: () => `file://${remote}`,
    pullRefs: async () => ({ baseSha: shas[0]!, headSha: shas[1]! }),
  });
}

async function waitFor(svc: AtlasService, repo: string) {
  for (let i = 0; i < 100; i++) {
    const s = svc.status(repo);
    if (s.job?.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("analysis did not finish");
}

function app(svc: AtlasService, extra: { apiToken?: string; traceToken?: string } = {}) {
  return createApp({
    deps: { githubClient: new InMemoryGitHubClient({}), llmProvider: new MockProvider(), reviewStore: store, sandboxRoot: root, dlq: new DeadLetterQueue() },
    atlas: { service: svc, ...extra },
  });
}

describe("AtlasService", () => {
  it("clones, analyzes history as a job, and compares any two commits", async () => {
    const svc = service();
    expect(svc.analyze("acme/api").status).toBe("running");
    const { job, analysis } = await waitFor(svc, "acme/api");
    expect(job?.status).toBe("done");
    expect(analysis?.commits.map((c) => c.subject)).toEqual(["init", "remove limiter"]);
    expect(analysis?.recommendations[0]?.title).toBe("Add rate limiting to POST /login");

    const cmp = await svc.compare("acme/api", shas[0]!, shas[1]!);
    expect(cmp.diff.newFindings.map((f) => f.id)).toEqual(["auth-route-no-rate-limit:POST /login"]);
    expect(cmp.summary).toMatch(/1 new high-severity/);
    // The same change, told as what happens to the request: the limiter step is gone and the gap appears.
    expect(cmp.flows.map((f) => [f.label, f.summary])).toEqual([
      ["POST /login", "− rate limiter; ⚠ now: no rate limiter"],
      ["GET /health", "− rate limiter"],
    ]);
  });

  it("reports what a pull request changes", async () => {
    const impact = await service().prImpact("acme/api", 7, true);
    expect(impact.base).toBe(shas[0]);
    expect(impact.head).toBe(shas[1]);
    expect(impact.diff.newFindings[0]?.title).toBe("POST /login has no rate limiting");
    expect(impact.after?.metrics.routes).toBe(2);
    expect(impact.flows.map((f) => f.label)).toEqual(["POST /login", "GET /health"]);
  });

  it("rejects refs that git would read as options", async () => {
    const svc = service();
    svc.analyze("acme/api");
    await waitFor(svc, "acme/api");
    await expect(svc.graph("acme/api", "--output=/tmp/x")).rejects.toThrow(/invalid ref/);
    await expect(svc.graph("acme/api", "../../etc")).rejects.toThrow(/invalid ref/);
  });

  it("reports a missing repo as a failed job, not a crash", async () => {
    const svc = new AtlasService({ cacheDir: path.join(root, "cache"), remoteUrl: () => `file://${root}/nope` });
    svc.analyze("acme/nope");
    const { job } = await waitFor(svc, "acme/nope");
    expect(job?.status).toBe("failed");
  });
});

describe("atlas routes", () => {
  it("runs the analyze → poll → compare flow over HTTP", async () => {
    const svc = service();
    const a = app(svc);
    expect((await request(a).post("/api/atlas/analyze").send({ repo: "not a repo" })).status).toBe(400);
    expect((await request(a).post("/api/atlas/analyze").send({ repo: "acme/api" })).body.job.status).toBe("running");
    await waitFor(svc, "acme/api");
    const status = await request(a).get("/api/atlas/acme/api");
    expect(status.body.analysis.commits).toHaveLength(2);
    const cmp = await request(a).get(`/api/atlas/acme/api/compare?from=${shas[0]}&to=${shas[1]}`);
    expect(cmp.body.diff.newFindings).toHaveLength(1);
    const flows = await request(a).get(`/api/atlas/acme/api/flows?ref=${shas[0]}`);
    expect(flows.body.map((f: { method: string; path: string; steps: Array<{ title: string }> }) => [`${f.method} ${f.path}`, f.steps.map((s) => s.title)])).toEqual([
      ["POST /login", ["Client sends POST /login", "Rate limiter", "Runs h()"]],
      ["GET /health", ["Client sends GET /health", "Rate limiter", "Runs h()"]],
    ]);
    const arch = await request(a).get("/api/atlas/acme/api/architecture");
    expect(arch.body.stories.map((st: { label: string; title: string }) => `${st.label} · ${st.title}`)).toEqual([
      "POST /login · Handles a request: no rate limiter",
      "GET /health · Handles a request",
    ]);
    expect(cmp.body.architecture.summary).toEqual(["⚠ now: no rate limiter", "− Rate limiter"]);
    const report = await request(a).get("/api/atlas/acme/api/report");
    expect(report.body.problems.map((p: { title: string; introducedIn?: { sha: string } }) => [p.title, p.introducedIn?.sha])).toEqual([
      ["POST /login has no rate limiting", shas[1]],
    ]);
    expect(report.body.problems[0].prompt).toContain("You are working in the repository acme/api.");
    expect(report.body.commits[0]).toMatchObject({ sha: shas[1], open: ["auth-route-no-rate-limit:POST /login"] });
    expect((await request(a).get("/api/atlas/acme/other/graph")).status).toBe(409);
  });

  it("accepts OTLP JSON traces (with a token when configured) and exposes the live call graph", async () => {
    const svc = service();
    const a = app(svc, { traceToken: "tt" });
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeSpans: [
            {
              spans: [
                { traceId: "t", spanId: "a", name: "POST /login", kind: 2, startTimeUnixNano: "0", endTimeUnixNano: "50000000", attributes: [{ key: "http.request.method", value: { stringValue: "POST" } }, { key: "http.route", value: { stringValue: "/login" } }] },
                { traceId: "t", spanId: "b", parentSpanId: "a", name: "SELECT", kind: 3, startTimeUnixNano: "1000000", endTimeUnixNano: "41000000", attributes: [{ key: "db.system", value: { stringValue: "postgresql" } }] },
              ],
            },
          ],
        },
      ],
    };
    expect((await request(a).post("/v1/traces?repo=acme/api").send(payload)).status).toBe(401);
    expect((await request(a).post("/v1/traces?repo=acme/api").set("Authorization", "Bearer tt").send(payload)).status).toBe(200);
    const rt = await request(a).get("/api/atlas/acme/api/runtime");
    expect(rt.body.snapshot.edges).toEqual([
      expect.objectContaining({ from: "r:POST /login", to: "db:postgresql", calls: 1, p50Ms: 40 }),
    ]);
  });

  it("streams runtime updates over server-sent events", async () => {
    const svc = service();
    const server = app(svc).listen(0);
    const port = (server.address() as { port: number }).port;
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/atlas/acme/api/runtime/stream`, (res) => {
        res.on("data", (chunk: Buffer) => {
          events.push(...chunk.toString().split("\n\n").filter((e) => e.startsWith("data:")));
          if (events.length === 1) {
            svc.ingestTraces("acme/api", {
              resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "t", spanId: "x", name: "job", startTimeUnixNano: "0", endTimeUnixNano: "1" }] }] }],
            });
          }
          if (events.length >= 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => (events.length >= 2 ? resolve() : reject(e)));
    });
    server.close();
    expect(JSON.parse(events[1]!.slice(5)).snapshot.spans).toBe(1);
  }, 10_000);

  it("lets the extension read with an API token when sign-in is required", async () => {
    const svc = service();
    const { InMemorySessionStore } = await import("../auth/sessions.js");
    const a = createApp({
      deps: { githubClient: new InMemoryGitHubClient({}), llmProvider: new MockProvider(), reviewStore: store, sandboxRoot: root, dlq: new DeadLetterQueue() },
      auth: { sessions: new InMemorySessionStore() },
      atlas: { service: svc, apiToken: "ext-token" },
    });
    expect((await request(a).get("/api/atlas/acme/api/pulls/7")).status).toBe(401);
    const ok = await request(a).get("/api/atlas/acme/api/pulls/7").set("Authorization", "Bearer ext-token");
    expect(ok.status).toBe(200);
    expect(ok.body.summary).toMatch(/new high-severity/);
  });
});
