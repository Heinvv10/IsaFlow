/**
 * Seed a row migration 899's CHECK refuses, without leaving the constraint off.
 *
 * `customer_invoices_amount_paid_within_total` refuses an amount_paid above the
 * (non-negative) total, and a NaN. A few suites exist to prove that a READER
 * copes with exactly such a legacy row (a NaN balance, an overpaid invoice, a
 * wrong-signed payment), so they must write one. A CHECK, unlike 692's trigger,
 * ignores `session_replication_role`, so the constraint has to be dropped.
 *
 * It is dropped ONLY around the seed: `liftAmountPaidCheck(seed)` drops it, runs
 * the seed, and re-adds it NOT VALID in a finally. A NOT VALID CHECK is not
 * checked against the rows already there but still refuses any later write of a
 * violating row, so the real write paths a suite then drives (the route under
 * test, the gateway, the link minting) stay guarded for the whole suite body.
 *
 * `restoreAmountPaidCheck()` goes in afterAll's `finally`, after the suite has
 * deleted its rows: it re-adds the constraint if it is missing and VALIDATES it,
 * so a suite that leaves an impossible row behind fails there, loudly, instead
 * of leaving the shard's later suites on a half-checked constraint. It is
 * idempotent, and throws unless the constraint is present and validated after.
 * vitest runs afterAll even when beforeAll or a case threw.
 *
 * Safe because each integration shard owns its own cluster and runs one file at
 * a time; the definition is read back from the catalogue (no copy to drift).
 */
import { Pool } from 'pg';

const NAME = 'customer_invoices_amount_paid_within_total';
const TABLE = 'public.customer_invoices';
let definition: string | null = null;

/** Own short-lived pool: a suite's cleanup helper may already have ended the suite's. */
async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try { return await fn(pool); } finally { await pool.end(); }
}

const lookup = (pool: Pool) => pool.query<{ def: string; ok: boolean }>(
  `SELECT pg_get_constraintdef(oid) AS def, convalidated AS ok FROM pg_constraint
    WHERE conname = $1 AND conrelid = '${TABLE}'::regclass`, [NAME]);

/** `pg_get_constraintdef` appends NOT VALID to an unvalidated constraint; the re-add states it itself. */
const bare = (def: string) => def.replace(/\s+NOT VALID$/, '');

const drop = () => withPool(async (pool) => {
  const found = await lookup(pool);
  if (found.rows.length === 0) return;
  definition = bare(found.rows[0]!.def);
  await pool.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ${NAME}`);
});

const addNotValid = () => withPool(async (pool) => {
  if ((await lookup(pool)).rows.length > 0) return;
  if (definition === null) throw new Error(`${NAME} is missing and was never lifted by this suite`);
  await pool.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${NAME} ${definition} NOT VALID`);
});

export async function liftAmountPaidCheck<T>(seed: () => Promise<T>): Promise<T> {
  await drop();
  try { return await seed(); } finally { await addNotValid(); }
}

export const restoreAmountPaidCheck = () => withPool(async (pool) => {
  await addNotValid();
  await pool.query(`ALTER TABLE ${TABLE} VALIDATE CONSTRAINT ${NAME}`);
  const after = await lookup(pool);
  if (after.rows.length !== 1 || !after.rows[0]!.ok) throw new Error(`${NAME} is not present and validated after restore`);
});
