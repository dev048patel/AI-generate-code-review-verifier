import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool, TEST_DATABASE_URL } from "../db/testDb.js";
import { InMemoryJobQueue, MAX_ATTEMPTS, retryDelayMs, type JobQueue } from "./JobQueue.js";
import { PostgresJobQueue } from "./PostgresJobQueue.js";

const job = (headSha: string, prNumber = 1) => ({ owner: "acme", repo: "api", prNumber, headSha, installationId: 42 });

function contract(name: string, make: () => Promise<JobQueue>) {
  describe(`${name} queue contract`, () => {
    let q: JobQueue;
    beforeEach(async () => {
      q = await make();
    });

    it("drops a redelivered webhook and a second event for the same commit", async () => {
      expect((await q.enqueue(job("a"), "delivery-1")).enqueued).toBe(true);
      expect(await q.enqueue(job("a"), "delivery-1")).toMatchObject({ enqueued: false, reason: "duplicate-delivery" });
      expect(await q.enqueue(job("a"), "delivery-2")).toMatchObject({ enqueued: false, reason: "duplicate-commit" });
    });

    it("hands each job to exactly one worker", async () => {
      await q.enqueue(job("a"));
      const [x, y] = await Promise.all([q.claim("w1"), q.claim("w2")]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      expect(x ?? y).toMatchObject({ status: "running", attempts: 1, installationId: 42 });
    });

    it("supersedes queued jobs for older commits of the same PR", async () => {
      await q.enqueue(job("old"));
      await q.enqueue(job("other-pr", 2));
      await q.enqueue(job("new"));
      const claimed = [await q.claim("w"), await q.claim("w"), await q.claim("w")].filter(Boolean);
      expect(claimed.map((j) => j!.headSha).sort()).toEqual(["new", "other-pr"]);
    });

    it("tells a running job when a newer commit arrived, so it doesn't publish stale results", async () => {
      await q.enqueue(job("old"));
      const running = (await q.claim("w"))!;
      expect(await q.isSuperseded(running)).toBe(false);
      await q.enqueue(job("new"));
      expect(await q.isSuperseded(running)).toBe(true);
    });

    it("retries, then dead-letters after MAX_ATTEMPTS", async () => {
      await q.enqueue(job("a"));
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const claimed = await q.claim("w");
        expect(claimed?.attempts).toBe(i + 1);
        await q.fail(claimed!.id, new Error(`boom ${i}`));
      }
      expect(await q.claim("w")).toBeNull();
      const failed = await q.listFailed();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("boom") });
    });

    it("recovers a job whose worker died, but not one that is heartbeating", async () => {
      await q.enqueue(job("a"));
      await q.enqueue(job("b", 2));
      const dead = (await q.claim("w1"))!;
      const alive = (await q.claim("w2"))!;
      await new Promise((r) => setTimeout(r, 30));
      await q.heartbeat(alive.id);
      expect(await q.recoverStale(20)).toBe(1);
      await q.complete(alive.id);
      expect(dead.status).toBe("running");
    });
  });
}

// Retry delay 0 so the retry test can re-claim immediately.
contract("in-memory", async () => new InMemoryJobQueue(Date.now, () => 0));

describe.runIf(Boolean(TEST_DATABASE_URL))("postgres", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, drop } = await createTestPool());
  });
  afterAll(async () => drop?.());
  contract("postgres", async () => {
    await pool.query("TRUNCATE review_jobs, webhook_deliveries");
    return new PostgresJobQueue(pool, () => 0);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially with full jitter and a cap", () => {
    expect(retryDelayMs(1, () => 0.999)).toBeLessThan(30_000);
    expect(retryDelayMs(2, () => 0.999)).toBeGreaterThan(30_000);
    expect(retryDelayMs(20, () => 0.999)).toBeLessThanOrEqual(600_000);
  });
});
