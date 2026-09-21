/**
 * K-144 (review M-1) — RED before migration 657. The application-level claim
 * check in `matchTransaction` cannot hold under concurrency.
 *
 * The row lock `lockForStatusWrite` takes is on the BANK TRANSACTION, and two
 * racing requests binding the same journal line lock two DIFFERENT bank rows —
 * so they never contend. The claim SELECT runs at READ COMMITTED and cannot see
 * the peer's uncommitted UPDATE, so both pass and both commit, and one journal
 * line ends up bound to two bank transactions: double-counted in the reconciled
 * balance, which is the exact state the check exists to prevent.
 *
 * Only `uq_bank_tx_matched_line` closes it. Proven here with two real pool
 * clients whose statements interleave, not with mocks.
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

describeIfDb('K-144 M-1 one journal line may bind to only one bank transaction', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K144 Concurrency Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','K144 Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;

    const je = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
       VALUES ($1,'2026-03-10','K144 entry','posted',$2) RETURNING id`, [COMPANY, USER]);
    const jl = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,0,100,'K144 line') RETURNING id`, [COMPANY, je.rows[0].id, bankAccount]);
    line = jl.rows[0].id;

    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-10',-100,'K144 first','imported'),
              ($1,$2,'2026-03-10',-100,'K144 second','imported')
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

  it('refuses the second binding when both requests pass the application check', async () => {
    const a: PoolClient = await admin.connect();
    const b: PoolClient = await admin.connect();
    await a.query('BEGIN');
    await b.query('BEGIN');
    try {
      // A binds the line but has NOT committed, so B's claim SELECT — READ
      // COMMITTED, on its own snapshot — sees nothing and passes the check.
      await als.run(ctx(a), () => matchTransaction(COMPANY, txA, line));

      // B now runs the same call. Its UPDATE blocks on the unique index rather
      // than on any row lock (the two bank rows are different), and resolves
      // into a 23505 the moment A commits.
      const bCall = als.run(ctx(b), () => matchTransaction(COMPANY, txB, line));
      await new Promise(r => setTimeout(r, 400));
      await a.query('COMMIT');

      await expect(bCall).rejects.toThrow(/already matched to/i);

      // And B's transaction survived the refusal: the savepoint rolled the
      // 23505 back rather than leaving the whole request aborted (25P02), which
      // is what lets `autoMatchTransactions` skip this row and keep going.
      const still = await b.query('SELECT 1 AS ok');
      expect(still.rows[0].ok).toBe(1);
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }

    const bound = await admin.query(
      'SELECT id FROM bank_transactions WHERE company_id = $1 AND matched_journal_line_id = $2',
      [COMPANY, line]);
    expect(bound.rows).toHaveLength(1);
    expect(bound.rows[0].id).toBe(txA);
  }, 60000);

  // Adjacent case: the index is partial and per-tenant. Unbound rows (NULL) are
  // exempt — otherwise a second unmatched transaction could not exist at all.
  it('lets any number of transactions carry no journal line', async () => {
    const r = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-11',-10,'K144 null a','imported'),
              ($1,$2,'2026-03-11',-11,'K144 null b','imported')
       RETURNING id`, [COMPANY, bankAccount]);
    expect(r.rows).toHaveLength(2);
  });

  // Adjacent case: re-matching the SAME bank transaction to the line it already
  // holds is not a double-binding and must still be allowed.
  it('allows re-matching a transaction to the line it already holds', async () => {
    const c: PoolClient = await admin.connect();
    await c.query('BEGIN');
    try {
      const again = await als.run(ctx(c), () => matchTransaction(COMPANY, txA, line));
      expect(again.status).toBe('matched');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }, 60000);
});
