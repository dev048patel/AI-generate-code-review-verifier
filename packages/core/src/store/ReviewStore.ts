import Database from "better-sqlite3";
import type { ReviewResult } from "../types.js";

/**
 * Storage interface deliberately shaped like a DynamoDB single-table access
 * pattern (put/get by id, query by partition key `repo`) so the SQLite-backed
 * implementation used for local dev/tests can be swapped for a real
 * DynamoDB-backed implementation without touching callers.
 */
export interface ReviewStore {
  put(review: ReviewResult): Promise<void>;
  get(id: string): Promise<ReviewResult | undefined>;
  listByRepo(repo: string, limit?: number): Promise<ReviewResult[]>;
  listRecent(limit?: number): Promise<ReviewResult[]>;
  /** Most recent reviews across the given repos -- what a signed-in user is allowed to see. */
  listForRepos(repos: string[], limit?: number): Promise<ReviewResult[]>;
  close(): Promise<void>;
}

export class SqliteReviewStore implements ReviewStore {
  private db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        trust_score INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_repo ON reviews(repo);
      CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);
    `);
  }

  async put(review: ReviewResult): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO reviews (id, repo, pr_number, created_at, trust_score, payload)
         VALUES (@id, @repo, @prNumber, @createdAt, @trustScore, @payload)
         ON CONFLICT(id) DO UPDATE SET
           trust_score = excluded.trust_score,
           payload = excluded.payload`,
      )
      .run({
        id: review.id,
        repo: review.repo,
        prNumber: review.prNumber,
        createdAt: review.createdAt,
        trustScore: review.trustScore.score,
        payload: JSON.stringify(review),
      });
  }

  async get(id: string): Promise<ReviewResult | undefined> {
    const row = this.db.prepare(`SELECT payload FROM reviews WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as ReviewResult) : undefined;
  }

  async listByRepo(repo: string, limit = 50): Promise<ReviewResult[]> {
    const rows = this.db
      .prepare(`SELECT payload FROM reviews WHERE repo = ? ORDER BY created_at DESC LIMIT ?`)
      .all(repo, limit) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as ReviewResult);
  }

  async listRecent(limit = 50): Promise<ReviewResult[]> {
    const rows = this.db
      .prepare(`SELECT payload FROM reviews ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as ReviewResult);
  }

  async listForRepos(repos: string[], limit = 50): Promise<ReviewResult[]> {
    if (repos.length === 0) return [];
    const placeholders = repos.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT payload FROM reviews WHERE repo IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
      .all(...repos, limit) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as ReviewResult);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
