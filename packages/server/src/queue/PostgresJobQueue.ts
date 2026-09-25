import type pg from "pg";
import { MAX_ATTEMPTS, retryDelayMs, type EnqueueResult, type JobQueue, type QueuedJob, type QueuedJobInput } from "./JobQueue.js";

interface JobRow {
  id: string;
  installation_id: string | null;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  status: QueuedJob["status"];
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toJob(r: JobRow): QueuedJob {
  return {
    id: Number(r.id),
    installationId: r.installation_id === null ? undefined : Number(r.installation_id),
    owner: r.owner,
    repo: r.repo,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error ?? undefined,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Postgres-backed queue: `FOR UPDATE SKIP LOCKED` lets any number of worker
 * processes claim jobs concurrently without double-processing, and every
 * state change is a single atomic statement.
 */
export class PostgresJobQueue implements JobQueue {
  constructor(
    private readonly pool: pg.Pool,
    private readonly retryDelay: (attempts: number) => number = retryDelayMs,
  ) {}

  async enqueue(input: QueuedJobInput, deliveryId?: string): Promise<EnqueueResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (deliveryId) {
        const d = await client.query(
          "INSERT INTO webhook_deliveries (delivery_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [deliveryId],
        );
        if (d.rowCount === 0) {
          await client.query("ROLLBACK");
          return { enqueued: false, reason: "duplicate-delivery" };
        }
      }
      const inserted = await client.query<JobRow>(
        `INSERT INTO review_jobs (installation_id, owner, repo, pr_number, head_sha)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (owner, repo, pr_number, head_sha) DO NOTHING
         RETURNING *`,
        [input.installationId ?? null, input.owner, input.repo, input.prNumber, input.headSha],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<JobRow>(
          "SELECT * FROM review_jobs WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND head_sha = $4",
          [input.owner, input.repo, input.prNumber, input.headSha],
        );
        await client.query("COMMIT");
        return { enqueued: false, reason: "duplicate-commit", job: existing.rows[0] && toJob(existing.rows[0]) };
      }
      const job = inserted.rows[0]!;
      await client.query(
        `UPDATE review_jobs SET status = 'superseded', updated_at = now()
         WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND status = 'queued' AND id <> $4`,
        [input.owner, input.repo, input.prNumber, job.id],
      );
      await client.query("COMMIT");
      return { enqueued: true, job: toJob(job) };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async claim(workerId: string): Promise<QueuedJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE review_jobs SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $1, updated_at = now()
       WHERE id = (
         SELECT id FROM review_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [workerId],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async heartbeat(id: number): Promise<void> {
    await this.pool.query("UPDATE review_jobs SET locked_at = now() WHERE id = $1 AND status = 'running'", [id]);
  }

  async complete(id: number, reviewId?: string): Promise<void> {
    await this.pool.query(
      `UPDATE review_jobs SET status = 'done', review_id = $2, locked_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id, reviewId ?? null],
    );
  }

  async fail(id: number, error: unknown): Promise<void> {
    const { rows } = await this.pool.query<{ attempts: number }>("SELECT attempts FROM review_jobs WHERE id = $1", [id]);
    const attempts = rows[0]?.attempts ?? MAX_ATTEMPTS;
    const lastError = String(error).slice(0, 2000);
    if (attempts >= MAX_ATTEMPTS) {
      await this.pool.query(
        "UPDATE review_jobs SET status = 'failed', last_error = $2, locked_at = NULL, updated_at = now() WHERE id = $1",
        [id, lastError],
      );
    } else {
      await this.pool.query(
        `UPDATE review_jobs SET status = 'queued', last_error = $2, locked_at = NULL,
           run_after = now() + ($3 || ' milliseconds')::interval, updated_at = now()
         WHERE id = $1`,
        [id, lastError, String(this.retryDelay(attempts))],
      );
    }
  }

  async isSuperseded(job: QueuedJob): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM review_jobs
       WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND id > $4 AND status <> 'superseded' LIMIT 1`,
      [job.owner, job.repo, job.prNumber, job.id],
    );
    return rows.length > 0;
  }

  async listFailed(limit = 50): Promise<QueuedJob[]> {
    const { rows } = await this.pool.query<JobRow>(
      "SELECT * FROM review_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT $1",
      [limit],
    );
    return rows.map(toJob);
  }

  async recoverStale(staleAfterMs: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM review_jobs WHERE status = 'running' AND locked_at < now() - ($1 || ' milliseconds')::interval`,
      [String(staleAfterMs)],
    );
    for (const r of rows) await this.fail(Number(r.id), "worker stopped responding (stale lock)");
    return rows.length;
  }
}
