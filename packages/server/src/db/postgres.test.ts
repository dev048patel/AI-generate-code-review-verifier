import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { ReviewResult } from "@acrv/core";
import { PostgresSessionStore } from "../auth/sessions.js";
import { PostgresSpendLedger } from "../budget.js";
import { migrate } from "./migrate.js";
import { PostgresReviewStore } from "./PostgresReviewStore.js";
import { createTestPool, TEST_DATABASE_URL } from "./testDb.js";

function review(id: string, repo: string, createdAt: string): ReviewResult {
  return {
    id,
    repo,
    prNumber: 1,
    headSha: "a".repeat(40),
    createdAt,
    isTrivial: false,
    trivialReasons: [],
    changedFunctions: [],
    generatedTests: [],
    trustScore: { score: 60, label: "needs-review", components: { llmRisk: 60, mutationCoverage: 60, testHealth: 60, ruleFlags: 60 }, evidence: [] },
    costUsd: 0.01,
    latencyMs: 5,
  };
}

describe.runIf(Boolean(TEST_DATABASE_URL))("postgres persistence", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, drop } = await createTestPool());
  });
  afterAll(async () => drop?.());

  it("migrations are idempotent", async () => {
    await migrate(pool);
    await migrate(pool);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(rows[0].n).toBe(1);
  });

  it("stores reviews and lists them per repo set, newest first", async () => {
    const store = new PostgresReviewStore(pool);
    await store.put(review("11111111-1111-1111-1111-111111111111", "acme/api", "2026-01-01T00:00:00Z"));
    await store.put(review("22222222-2222-2222-2222-222222222222", "acme/web", "2026-01-02T00:00:00Z"));
    await store.put(review("33333333-3333-3333-3333-333333333333", "other/x", "2026-01-03T00:00:00Z"));
    const visible = await store.listForRepos(["acme/api", "acme/web"]);
    expect(visible.map((r) => r.repo)).toEqual(["acme/web", "acme/api"]);
    expect((await store.get("33333333-3333-3333-3333-333333333333"))?.repo).toBe("other/x");
    expect(await store.get("not-a-uuid")).toBeUndefined();
    expect(await store.listForRepos([])).toEqual([]);
  });

  it("expires sessions", async () => {
    const sessions = new PostgresSessionStore(pool);
    const live = await sessions.create("alice", ["acme/api"], 60_000);
    const dead = await sessions.create("bob", [], -1);
    expect(await sessions.get(live.id)).toMatchObject({ login: "alice", repos: ["acme/api"] });
    expect(await sessions.get(dead.id)).toBeUndefined();
    await sessions.delete(live.id);
    expect(await sessions.get(live.id)).toBeUndefined();
  });

  it("accumulates spend per account and month atomically", async () => {
    const ledger = new PostgresSpendLedger(pool);
    await Promise.all(Array.from({ length: 20 }, () => ledger.add("acme", "2026-09", 0.25)));
    expect(await ledger.spent("acme", "2026-09")).toBeCloseTo(5);
    expect(await ledger.spent("acme", "2026-10")).toBe(0);
  });
});
