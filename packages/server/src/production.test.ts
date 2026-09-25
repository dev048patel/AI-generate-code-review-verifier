import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SqliteReviewStore, type ReviewResult, type RiskClassification } from "@acrv/core";
import { MockProvider, type LLMProvider } from "@acrv/llm";
import { InMemorySessionStore } from "./auth/sessions.js";
import { BudgetedProvider, InMemorySpendLedger } from "./budget.js";
import { createAppJwt, GitHubAppAuth } from "./githubApp.js";
import { InMemoryGitHubClient } from "./githubClient.js";
import { createApp, type CreateAppOptions } from "./httpApp.js";
import { InMemoryJobQueue } from "./queue/JobQueue.js";
import { DeadLetterQueue } from "./reviewPipeline.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const sandboxRoot = path.join(repoRoot, "sandbox-runs");
const PUBLIC_URL = "https://acrv.example.com";
const SECRET = "whsec";

beforeAll(async () => {
  await mkdir(sandboxRoot, { recursive: true });
});

let store: SqliteReviewStore | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

function review(repo: string, id: string): ReviewResult {
  return {
    id,
    repo,
    prNumber: 1,
    headSha: "a".repeat(40),
    createdAt: new Date().toISOString(),
    isTrivial: false,
    trivialReasons: [],
    changedFunctions: [],
    generatedTests: [],
    trustScore: { score: 70, label: "needs-review", components: { llmRisk: 70, mutationCoverage: 70, testHealth: 70, ruleFlags: 70 }, evidence: [] },
    costUsd: 0,
    latencyMs: 1,
  };
}

/** A fake GitHub for the OAuth dance: user "alice" can see acme/api only. */
const fakeGitHub: typeof fetch = async (input) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/login/oauth/access_token")) return json({ access_token: "gho_user" });
  if (url.endsWith("/user")) return json({ login: "alice" });
  if (url.includes("/user/installations?")) return json({ installations: [{ id: 7 }] });
  if (url.includes("/user/installations/7/repositories")) return json({ repositories: [{ full_name: "acme/api" }] });
  return new Response("not found", { status: 404 });
};

function prodApp(overrides: Partial<CreateAppOptions> = {}) {
  store = new SqliteReviewStore(":memory:");
  const queue = new InMemoryJobQueue();
  const sessions = new InMemorySessionStore();
  const app = createApp({
    deps: { githubClient: new InMemoryGitHubClient({}), llmProvider: new MockProvider(), reviewStore: store, sandboxRoot, dlq: new DeadLetterQueue() },
    webhookSecret: SECRET,
    queue,
    auth: { sessions, oauth: { clientId: "cid", clientSecret: "csecret", publicUrl: PUBLIC_URL }, fetchImpl: fakeGitHub },
    production: true,
    publicUrl: PUBLIC_URL,
    ...overrides,
  });
  return { app, queue, store, sessions };
}

async function signIn(app: ReturnType<typeof prodApp>["app"]): Promise<string> {
  const login = await request(app).get("/auth/login");
  const stateCookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const state = new URL(login.headers.location as string).searchParams.get("state")!;
  const cb = await request(app).get(`/auth/callback?code=c&state=${state}`).set("Cookie", stateCookie);
  expect(cb.status).toBe(302);
  const cookies = cb.headers["set-cookie"] as unknown as string[];
  const session = cookies.find((c) => c.startsWith("acrv_session="))!;
  expect(session).toContain("HttpOnly");
  expect(session).toContain("Secure");
  return session.split(";")[0]!;
}

function signed(body: object): { raw: string; sig: string } {
  const raw = JSON.stringify(body);
  return { raw, sig: `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` };
}

describe("production app", () => {
  it("refuses to start without the production essentials", () => {
    expect(() => prodApp({ webhookSecret: undefined })).toThrow(/WEBHOOK_SECRET/);
    expect(() => prodApp({ queue: undefined })).toThrow(/queue/);
  });

  it("requires sign-in, and only shows reviews for repos the user can access", async () => {
    const { app, store } = prodApp();
    await store.put(review("acme/api", "11111111-1111-1111-1111-111111111111"));
    await store.put(review("other/secret", "22222222-2222-2222-2222-222222222222"));

    expect((await request(app).get("/api/reviews")).status).toBe(401);
    const cookie = await signIn(app);

    const list = await request(app).get("/api/reviews").set("Cookie", cookie);
    expect(list.body.reviews.map((r: ReviewResult) => r.repo)).toEqual(["acme/api"]);
    expect((await request(app).get("/api/reviews?repo=other/secret").set("Cookie", cookie)).body.reviews).toEqual([]);
    expect((await request(app).get("/api/reviews/22222222-2222-2222-2222-222222222222").set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).get("/api/reviews/11111111-1111-1111-1111-111111111111").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/auth/me").set("Cookie", cookie)).body.login).toBe("alice");
  });

  it("rejects an OAuth callback whose state doesn't match", async () => {
    const { app } = prodApp();
    const res = await request(app).get("/auth/callback?code=c&state=forged").set("Cookie", "acrv_oauth_state=real");
    expect(res.status).toBe(400);
  });

  it("blocks cross-site writes and live reviews of repos outside the user's installations", async () => {
    const { app } = prodApp();
    const cookie = await signIn(app);
    const forged = await request(app)
      .post("/api/live-review")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example")
      .send({ owner: "acme", repo: "api", prNumber: 1 });
    expect(forged.status).toBe(403);
    const foreign = await request(app)
      .post("/api/live-review")
      .set("Cookie", cookie)
      .set("Origin", PUBLIC_URL)
      .send({ owner: "someone", repo: "else", prNumber: 1 });
    expect(foreign.status).toBe(404);
  });

  it("turns off demo endpoints", async () => {
    const { app } = prodApp();
    expect((await request(app).get("/api/fixtures")).status).toBe(404);
    expect((await request(app).post("/api/simulate-diff").set("Origin", PUBLIC_URL).send({})).status).toBe(404);
  });

  it("verifies webhook signatures and enqueues each delivery exactly once", async () => {
    const { app, queue } = prodApp();
    const body = {
      action: "synchronize",
      installation: { id: 99 },
      pull_request: { number: 5, head: { sha: "b".repeat(40) } },
      repository: { owner: { login: "acme" }, name: "api" },
    };
    const { raw, sig } = signed(body);
    const send = (signature: string, delivery: string) =>
      request(app)
        .post("/webhooks/github")
        .set("Content-Type", "application/json")
        .set("x-github-event", "pull_request")
        .set("x-github-delivery", delivery)
        .set("x-hub-signature-256", signature)
        .send(raw);

    expect((await send("sha256=bad", "d1")).status).toBe(401);
    expect((await send(sig, "d1")).body).toMatchObject({ queued: true });
    expect((await send(sig, "d1")).body).toMatchObject({ queued: false, reason: "duplicate-delivery" });
    expect(queue.all()).toHaveLength(1);
    expect(queue.all()[0]).toMatchObject({ installationId: 99, headSha: "b".repeat(40), prNumber: 5 });
  });

  it("protects /metrics with a bearer token", async () => {
    const { app } = prodApp({ metrics: new (await import("./observability.js")).Metrics(), metricsToken: "m" });
    expect((await request(app).get("/metrics")).status).toBe(401);
    expect((await request(app).get("/metrics").set("Authorization", "Bearer m")).status).toBe(200);
  });
});

describe("GitHub App auth", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs a short-lived RS256 app JWT", () => {
    const jwt = createAppJwt("123", pem, 1_000_000);
    const [h, p, s] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload).toEqual({ iat: 1_000_000 - 60, exp: 1_000_000 + 540, iss: "123" });
  });

  it("mints repo-scoped, least-privilege installation tokens and caches them until near expiry", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let now = Date.parse("2026-01-01T00:00:00Z");
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ token: `ghs_${calls.length}`, expires_at: new Date(now + 3600_000).toISOString() }), { status: 201 });
    };
    const auth = new GitHubAppAuth("123", pem, fetchImpl, () => now);
    const req = { installationId: 9, repository: "api", permissions: { contents: "read" as const } };
    expect(await auth.installationToken(req)).toBe("ghs_1");
    expect(await auth.installationToken(req)).toBe("ghs_1");
    expect(calls[0]).toEqual({
      url: "https://api.github.com/app/installations/9/access_tokens",
      body: { repositories: ["api"], permissions: { contents: "read" } },
    });
    now += 56 * 60_000; // within 5 minutes of expiry
    expect(await auth.installationToken(req)).toBe("ghs_2");
  });
});

describe("BudgetedProvider", () => {
  it("stops calling the model once an account's monthly budget is spent, and scores that as unknown", async () => {
    let calls = 0;
    const inner: LLMProvider = {
      name: "anthropic",
      async classify(): Promise<RiskClassification> {
        calls++;
        return { riskLevel: "low", summary: "", intent: "", findings: [], fromFallback: false, costUsd: 0.6 };
      },
    };
    const ledger = new InMemorySpendLedger();
    const provider = new BudgetedProvider(inner, ledger, "acme", 1);
    const req = { repo: "acme/api", prTitle: "", prDescription: "", files: [], changedFunctions: [] };
    await provider.classify(req);
    await provider.classify(req); // 0.6 < 1: allowed, may overshoot by one review
    const third = await provider.classify(req);
    expect(calls).toBe(2);
    expect(third).toMatchObject({ skipped: true, costUsd: 0 });
    expect(third.summary).toMatch(/monthly budget/);
    // Another account is unaffected.
    await new BudgetedProvider(inner, ledger, "other", 1).classify(req);
    expect(calls).toBe(3);
  });
});
