/**
 * K-144 (review r2 M-A) — the double-binding race seen SLOWLY.
 *
 * Before `uq_bank_tx_matched_line` the two racers locked different bank rows
 * and never blocked. The unique index makes the loser block on the INDEX, and
 * that wait is bounded by the 5s `SET LOCAL lock_timeout`
 * `lockBankTransactionForUpdate` issues on the same connection. A peer holding
 * its transaction past that hands `matchTransaction`'s UPDATE a raw 55P03, not
 * the 23505 the commit mapped — and unmapped it escapes as a bare pg error that
 * `autoMatchTransactions` does not recognise, so the run aborts and `withAuth`
 * COMMITs the 4xx with the matches already applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTransactionQueryService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount = '';
let line = '';
let txA = '';
let txB = '';

function ctx(client: PoolClient) {
  return { client, userId: USER, companyId: COMPANY, claims: {} } as never;
}

describeIfDb('K-144 M-A a slow peer is the same race, not a bare pg error', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'M-A Lock Timeout Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','M-A Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;
    const je = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
       VALUES ($1,'2026-03-10','M-A entry','posted',$2) RETURNING id`, [COMPANY, USER]);
    const jl = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,0,100,'M-A line') RETURNING id`, [COMPANY, je.rows[0].id, bankAccount]);
    line = jl.rows[0].id;
    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-10',-100,'M-A first','imported'),
              ($1,$2,'2026-03-10',-100,'M-A second','imported')
       RETURNING id`, [COMPANY, bankAccount]);
    txA = tx.rows[0].id;
    txB = tx.rows[1].id;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('reports a peer that outlives lock_timeout as LINE_CLAIMED, and leaves the transaction usable', async () => {
    const a: PoolClient = await admin.connect();
    const b: PoolClient = await admin.connect();
    await a.query('BEGIN');
    await b.query('BEGIN');
    try {
      // A binds the line and holds its transaction open past B's 5s timeout.
      await als.run(ctx(a), () => matchTransaction(COMPANY, txA, line));

      // B's claim SELECT cannot see A's uncommitted row, so it reaches the
      // UPDATE, blocks on the index, and is cancelled by lock_timeout — 55P03.
      await expect(als.run(ctx(b), () => matchTransaction(COMPANY, txB, line)))
        .rejects.toThrow(/already matched to another bank transaction/i);

      // The savepoint rolled the cancellation back, so B is not aborted (25P02)
      // and `autoMatchTransactions` can skip this row and keep going.
      const still = await b.query('SELECT 1 AS ok');
      expect(still.rows[0].ok).toBe(1);
    } finally {
      await b.query('ROLLBACK');
      await a.query('ROLLBACK');
      a.release();
      b.release();
    }
  }, 60000);
});
