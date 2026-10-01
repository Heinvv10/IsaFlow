/**
 * generateDueCharges()/runQueuedCharges() are process-wide crons: they act on
 * every due subscription in the database, so two test files exercising them
 * against the same schema would consume each other's fixtures. Each file holds
 * this advisory lock for its whole run, which serialises them without turning
 * off file parallelism for the rest of the integration suite.
 */
import type { Pool, PoolClient } from 'pg';

const LOCK_KEY = 908_033;

export async function acquireCronLock(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  return client;
}

export async function releaseCronLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  } finally {
    client.release();
  }
}
