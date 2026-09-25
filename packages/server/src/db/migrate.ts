import pg from "pg";

/**
 * Forward-only schema migrations, applied in order inside a transaction and
 * recorded in schema_migrations. An advisory lock keeps concurrently starting
 * web/worker processes from racing each other.
 */
const MIGRATIONS: Array<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
      CREATE TABLE reviews (
        id UUID PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        trust_score INTEGER NOT NULL,
        payload JSONB NOT NULL
      );
      CREATE INDEX reviews_repo_created ON reviews (repo, created_at DESC);
      CREATE INDEX reviews_created ON reviews (created_at DESC);

      CREATE TABLE review_jobs (
        id BIGSERIAL PRIMARY KEY,
        installation_id BIGINT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        last_error TEXT,
        review_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- One review per commit: redeliveries and reopen events for the same head are no-ops.
        UNIQUE (owner, repo, pr_number, head_sha)
      );
      CREATE INDEX review_jobs_claim ON review_jobs (run_after, id) WHERE status = 'queued';
      CREATE INDEX review_jobs_pr ON review_jobs (owner, repo, pr_number);

      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE llm_spend (
        account TEXT NOT NULL,
        month TEXT NOT NULL,
        usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
        PRIMARY KEY (account, month)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        repos JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX sessions_expires ON sessions (expires_at);
    `,
  },
];

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: Number(process.env.ACRV_DB_POOL_SIZE ?? 10) });
}
