import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteReviewStore } from "./ReviewStore.js";
import type { ReviewResult } from "../types.js";

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    id: overrides.id ?? "review-1",
    repo: overrides.repo ?? "acme/widgets",
    prNumber: overrides.prNumber ?? 42,
    headSha: "abc123",
    createdAt: new Date().toISOString(),
    isTrivial: false,
    trivialReasons: [],
    changedFunctions: [],
    generatedTests: [],
    trustScore: { score: 88, label: "trusted", components: { llmRisk: 90, mutationCoverage: 90, testHealth: 90, ruleFlags: 90 }, evidence: [] },
    costUsd: 0.01,
    latencyMs: 1200,
    ...overrides,
  };
}

describe("SqliteReviewStore", () => {
  let store: SqliteReviewStore;

  beforeEach(() => {
    store = new SqliteReviewStore(":memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  it("stores and retrieves a review by id", async () => {
    const review = makeReview();
    await store.put(review);
    const fetched = await store.get(review.id);
    expect(fetched?.id).toBe(review.id);
    expect(fetched?.trustScore.score).toBe(88);
  });

  it("returns undefined for a missing id", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("lists reviews by repo, most recent first", async () => {
    await store.put(makeReview({ id: "r1", repo: "acme/widgets", createdAt: "2024-01-01T00:00:00Z" }));
    await store.put(makeReview({ id: "r2", repo: "acme/widgets", createdAt: "2024-01-02T00:00:00Z" }));
    await store.put(makeReview({ id: "r3", repo: "other/repo", createdAt: "2024-01-03T00:00:00Z" }));

    const list = await store.listByRepo("acme/widgets");
    expect(list.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("upserts on duplicate id", async () => {
    await store.put(makeReview({ id: "r1", trustScore: { score: 50, label: "high-risk", components: { llmRisk: 50, mutationCoverage: 50, testHealth: 50, ruleFlags: 50 }, evidence: [] } }));
    await store.put(makeReview({ id: "r1", trustScore: { score: 90, label: "trusted", components: { llmRisk: 90, mutationCoverage: 90, testHealth: 90, ruleFlags: 90 }, evidence: [] } }));
    const fetched = await store.get("r1");
    expect(fetched?.trustScore.score).toBe(90);
  });

  it("listRecent respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.put(makeReview({ id: `r${i}`, createdAt: `2024-01-0${i + 1}T00:00:00Z` }));
    }
    const list = await store.listRecent(2);
    expect(list).toHaveLength(2);
  });
});
