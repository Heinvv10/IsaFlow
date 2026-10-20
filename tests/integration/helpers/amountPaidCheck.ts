/**
 * Lift migration 899's CHECK on customer_invoices.amount_paid for one suite.
 *
 * `customer_invoices_amount_paid_within_total` refuses an amount_paid above the
 * (non-negative) total, a NaN, and any payment on a negative total. A few suites
 * exist to prove that a READER copes with exactly such a legacy row (a NaN
 * balance, an overpaid invoice, a wrong-signed payment), so they must write one.
 * A CHECK, unlike 692's trigger, ignores `session_replication_role`, so the only
 * way to write the row is to drop the constraint for the duration of the suite.
 *
 * Safe because each integration shard owns its own cluster and runs one file at a
 * time. USE: `suspendAmountPaidCheck()` first in beforeAll; in afterAll put the
 * suite's own cleanup in a `try` and `restoreAmountPaidCheck()` in its `finally`,
 * so a cleanup that throws still restores. vitest runs afterAll even when
 * beforeAll or a case threw.
 *
 * Restore is idempotent (a no-op when the constraint is present, so a second call
 * or a suite that never suspended is harmless) and re-adds with the definition
 * read back at suspend time (no copy of the predicate to drift). Being a plain
 * ADD CONSTRAINT it VALIDATES: call it after the suite has deleted its rows. A
 * suite that leaves an impossible row behind fails there, loudly, rather than
 * leaving the shard's later suites without the constraint; and it throws unless
 * the constraint is present and validated afterwards.
 */
import { Pool } from 'pg';

const NAME = 'customer_invoices_amount_paid_within_total';
let definition: string | null = null;

/** Own short-lived pool: a suite's cleanup helper may already have ended the suite's. */
async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try { return await fn(pool); } finally { await pool.end(); }
}

const lookup = (pool: Pool) => pool.query<{ def: string; ok: boolean }>(
  `SELECT pg_get_constraintdef(oid) AS def, convalidated AS ok FROM pg_constraint
    WHERE conname = $1 AND conrelid = 'public.customer_invoices'::regclass`, [NAME]);

export const suspendAmountPaidCheck = () => withPool(async (pool) => {
  const found = await lookup(pool);
  if (found.rows.length === 0) return;
  definition = found.rows[0]!.def;
  await pool.query(`ALTER TABLE public.customer_invoices DROP CONSTRAINT ${NAME}`);
});

export const restoreAmountPaidCheck = () => withPool(async (pool) => {
  if ((await lookup(pool)).rows.length === 0) {
    if (definition === null) throw new Error(`${NAME} is missing and was never suspended by this suite`);
    await pool.query(`ALTER TABLE public.customer_invoices ADD CONSTRAINT ${NAME} ${definition}`);
  }
  const after = await lookup(pool);
  if (after.rows.length !== 1 || !after.rows[0]!.ok) throw new Error(`${NAME} is not present and validated after restore`);
});
