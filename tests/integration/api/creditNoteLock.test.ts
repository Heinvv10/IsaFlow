/**
 * lockCreditNoteForUpdate — the serialisation guarantee, tested deterministically.
 *
 * approveCreditNote and cancelCreditNote read `credit_notes.status`, refuse on
 * the wrong status, then post to the ledger and rewrite the row. Without a row
 * lock two concurrent requests both read 'draft', both post a journal, and a
 * linked note has its total added to the invoice's amount_paid twice.
 *
 * An end-to-end "fire two approvals at once" test cannot prove the remedy: the
 * interleaving is timing-dependent and passes just as happily with the lock
 * removed. What IS deterministic is the lock's own contract, which is what the
 * services depend on:
 *
 *   - a second transaction asking for the same row BLOCKS while the first holds it
 *   - it surfaces as CreditNoteLockTimeoutError rather than hanging forever
 *   - a DIFFERENT row is never blocked (the lock is per-note, not a table lock)
 *   - it refuses to run outside a request transaction, where FOR UPDATE would
 *     release immediately and serialise nothing
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  lockCreditNoteForUpdate,
  CreditNoteLockTimeoutError,
} from '@/modules/accounting/services/ar/creditNoteLock';

const COMPANY = '00000000-0000-0000-0000-000000000aa1';
const USER = '00000000-0000-0000-e2e0-000000000001';
const TAG = `CNLOCK-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let customer: string;
let noteA: string;
let noteB: string;

async function makeNote(): Promise<string> {
  const rows = await sql`
    INSERT INTO credit_notes (company_id, type, client_id, credit_date, subtotal, tax_rate, tax_amount, total_amount, created_by)
    VALUES (${COMPANY}::UUID, 'customer', ${customer}::UUID, '2026-06-30', 100, 15, 15, 115, ${USER}::UUID)
    RETURNING id` as { id: string }[];
  return rows[0]!.id;
}

/** Run fn on its own client inside a transaction that the caller closes. */
async function begin(): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  return c;
}
function on<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  customer = (await sql`INSERT INTO customers (name, company_id) VALUES (${'LOCK ' + TAG}, ${COMPANY}::UUID) RETURNING id` as { id: string }[])[0]!.id;
  noteA = await makeNote();
  noteB = await makeNote();
});

afterAll(async () => {
  await sql`DELETE FROM credit_notes WHERE client_id = ${customer}::UUID`;
  await sql`DELETE FROM customers WHERE id = ${customer}::UUID`;
  await pool.end();
});

describe('lockCreditNoteForUpdate', () => {
  it('refuses to run outside a request transaction', async () => {
    await expect(lockCreditNoteForUpdate(COMPANY, noteA)).rejects.toThrow(/requires a request transaction/);
  });

  it('returns null for a note belonging to another tenant', async () => {
    const c = await begin();
    try {
      expect(await on(c, () => lockCreditNoteForUpdate('00000000-0000-0000-0000-000000000aa2', noteA))).toBeNull();
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('blocks a second transaction on the SAME note until the first commits', async () => {
    const a = await begin();
    const b = await begin();
    try {
      expect(await on(a, () => lockCreditNoteForUpdate(COMPANY, noteA))).not.toBeNull();

      let settled = false;
      const contender = on(b, () => lockCreditNoteForUpdate(COMPANY, noteA))
        .then((r) => { settled = true; return r; });

      // Give the contender a real chance to complete. It must NOT: A holds the row.
      await new Promise((r) => setTimeout(r, 700));
      expect(settled, 'second transaction acquired the lock while the first held it').toBe(false);

      await a.query('COMMIT');
      expect(await contender).not.toBeNull();
      settled = true;
    } finally {
      await b.query('ROLLBACK').catch(() => {});
      a.release(); b.release();
    }
  });

  it('does not block a DIFFERENT note — the lock is per row, not per table', async () => {
    const a = await begin();
    const b = await begin();
    try {
      await on(a, () => lockCreditNoteForUpdate(COMPANY, noteA));
      // Resolves promptly rather than waiting on A.
      const other = await Promise.race([
        on(b, () => lockCreditNoteForUpdate(COMPANY, noteB)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('blocked on an unrelated note')), 2000)),
      ]);
      expect(other).not.toBeNull();
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      a.release(); b.release();
    }
  });

  it('surfaces a held row as CreditNoteLockTimeoutError instead of hanging', async () => {
    const a = await begin();
    const b = await begin();
    try {
      await on(a, () => lockCreditNoteForUpdate(COMPANY, noteA));
      await expect(on(b, () => lockCreditNoteForUpdate(COMPANY, noteA)))
        .rejects.toBeInstanceOf(CreditNoteLockTimeoutError);
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK').catch(() => {});
      a.release(); b.release();
    }
  }, 20000);
});
