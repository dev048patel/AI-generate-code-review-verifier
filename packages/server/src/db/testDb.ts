import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";

/** Test-only: set ACRV_TEST_DATABASE_URL to run the Postgres-backed tests. */
export const TEST_DATABASE_URL = process.env.ACRV_TEST_DATABASE_URL;

/** A pool bound to a fresh, migrated schema, so parallel test files never see each other's rows. */
export async function createTestPool(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error("ACRV_TEST_DATABASE_URL is not set");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
  await migrate(pool);
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
