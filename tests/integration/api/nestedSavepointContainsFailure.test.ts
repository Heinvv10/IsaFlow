/**
 * A failed inner savepoint must leave the outer one able to continue.
 *
 * This is the mechanism the PDF-seal fix rests on, executed rather than argued.
 *
 * Adversarial review, 2026-09-08: `snapshotInvoicePdf` does real SQL, so a
 * Postgres-level failure there aborts the CONNECTION. `approveCustomerInvoice`
 * catches and returns normally, and the enclosing `withSavepoint`'s own
 * `RELEASE SAVEPOINT` then raises 25P02 — one postable invoice failing and
 * taking the other 99 approvals of the batch with it. The fix wraps the seal in
 * its own savepoint so the catch means what it says.
 *
 * That fix is only correct if nested savepoints actually behave this way on
 * this connection, against a real database. The reviewer's coverage list was a
 * code-reading argument and explicitly not executed, and `withSavepoint` also
 * carries a `markTxUnusable` path that would make the outer scope unusable if
 * the inner rollback itself failed. So the shape is reproduced end to end here:
 * a genuine SQLSTATE inside the inner scope, caught, and the outer scope
 * expected to commit work afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, withSavepoint } from '@/lib/neon';

let pool: Pool;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run(
      {
        client: c,
        userId: '00000000-0000-0000-e2e0-000000000001',
        companyId: '00000000-0000-0000-0000-000000000ab5',
        claims: {},
      } as never,
      fn,
    );
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
});
afterAll(async () => { await pool.end(); });

describe('nested savepoints contain a SQL failure', () => {
  /**
   * The exact shape of the bulk approve: an outer per-element savepoint, an
   * inner best-effort one that fails at the SQL level and is swallowed, and the
   * outer scope expected to carry on and RELEASE cleanly.
   */
  it('lets the outer scope continue after the inner one fails and is caught', async () => {
    const result = await inTx(async () => withSavepoint('outer_element', async () => {
      // The seal's failure mode: a real SQLSTATE, not a thrown JS error.
      // Without the inner savepoint this aborts the connection for good.
      let sealFailed = false;
      try {
        await withSavepoint('invoice_pdf_snapshot', async () => {
          await sql`INSERT INTO captured_documents (id) VALUES (NULL)`;
        });
      } catch {
        // Exactly what approveCustomerInvoice does with a failed seal.
        sealFailed = true;
      }

      // The connection must still be usable — this is the whole claim.
      const rows = (await sql`SELECT 1 AS ok`) as { ok: number }[];
      return { sealFailed, ok: rows[0]!.ok };
    }));

    expect(result.sealFailed).toBe(true);
    expect(result.ok).toBe(1);
  });

  /**
   * The counter-proof: WITHOUT the inner savepoint the same swallowed failure
   * poisons the outer scope. This is what the production code did before the
   * fix, so it pins that the savepoint — not the catch — is what saves the batch.
   */
  it('WITHOUT the inner savepoint the same caught failure poisons the outer scope', async () => {
    const outcome = await inTx(async () => withSavepoint('outer_element', async () => {
      try {
        await sql`INSERT INTO captured_documents (id) VALUES (NULL)`;
      } catch {
        // Swallowed, exactly as the old code did.
      }
      // The next statement on an aborted connection fails.
      try {
        await sql`SELECT 1 AS ok`;
        return 'connection survived';
      } catch (err) {
        return `connection aborted: ${(err as { code?: string }).code ?? 'unknown'}`;
      }
    })).catch((err: unknown) => `outer threw: ${(err as { code?: string }).code ?? 'unknown'}`);

    // MEASURED, not asserted as a negative: the outer scope throws 25P02 —
    // the aborted-transaction error — from its own RELEASE SAVEPOINT. That is
    // exactly the batch-killing outcome the review described, and pinning the
    // observed value stops this passing vacuously if the shape ever changes.
    expect(outcome).toBe('outer threw: 25P02');
  });
});
