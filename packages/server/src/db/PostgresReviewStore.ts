import type pg from "pg";
import type { ReviewResult, ReviewStore } from "@acrv/core";

/** Production ReviewStore: one row per review, full result as JSONB, indexed by repo and time. */
export class PostgresReviewStore implements ReviewStore {
  constructor(private readonly pool: pg.Pool) {}

  async put(review: ReviewResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO reviews (id, repo, pr_number, head_sha, created_at, trust_score, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET trust_score = EXCLUDED.trust_score, payload = EXCLUDED.payload`,
      [review.id, review.repo, review.prNumber, review.headSha, review.createdAt, review.trustScore.score, review],
    );
  }

  async get(id: string): Promise<ReviewResult | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { rows } = await this.pool.query<{ payload: ReviewResult }>("SELECT payload FROM reviews WHERE id = $1", [id]);
    return rows[0]?.payload;
  }

  async listByRepo(repo: string, limit = 50): Promise<ReviewResult[]> {
    const { rows } = await this.pool.query<{ payload: ReviewResult }>(
      "SELECT payload FROM reviews WHERE repo = $1 ORDER BY created_at DESC LIMIT $2",
      [repo, clampLimit(limit)],
    );
    return rows.map((r) => r.payload);
  }

  async listRecent(limit = 50): Promise<ReviewResult[]> {
    const { rows } = await this.pool.query<{ payload: ReviewResult }>(
      "SELECT payload FROM reviews ORDER BY created_at DESC LIMIT $1",
      [clampLimit(limit)],
    );
    return rows.map((r) => r.payload);
  }

  async listForRepos(repos: string[], limit = 50): Promise<ReviewResult[]> {
    if (repos.length === 0) return [];
    const { rows } = await this.pool.query<{ payload: ReviewResult }>(
      "SELECT payload FROM reviews WHERE repo = ANY($1::text[]) ORDER BY created_at DESC LIMIT $2",
      [repos, clampLimit(limit)],
    );
    return rows.map((r) => r.payload);
  }

  async close(): Promise<void> {
    // The pool is shared and owned by the caller.
  }
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
}
