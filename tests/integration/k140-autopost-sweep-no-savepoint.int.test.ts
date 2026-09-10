/**
 * K-140 — RED. `sweep` (autoPostGateService.ts:276-352 on origin/master) runs
 * its per-row work inside a bare `try { … } catch { skipped.push(reason) }`
 * with NO savepoint around the row.
 *
 * Every request is one PostgreSQL transaction on the ALS client (src/lib/neon.ts
 * routes bare `sql` through `als.getStore().client`), so a row whose failure is
 * a Postgres ERROR raised OUTSIDE a nested savepoint aborts that transaction.
 * The catch swallows it and the loop continues — and every later row then fails
 * with 25P02 "current transaction is aborted", so its skip reason names the
 * abort rather than anything about that row, and the eventual COMMIT is a
 * rollback that throws the whole sweep away while the response still reports
 * success.
 *
 * The first statement of `allocateTransaction` is exactly such a case:
 * `lockBankTransactionForUpdate` (bankTxLock.ts) issues `SELECT … FOR UPDATE`
 * under `SET LOCAL lock_timeout = '5s'`, outside the `withTransaction` block
 * further down (bankAllocationService.ts:106 vs :404). A concurrent request
 * holding that row makes it raise 55P03.
 *
 * The sibling loop already does this right: `bankRulesMatchingService.ts:249`
 * wraps each candidate in `withSavepoint('rule_autopost_line', …)`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount = '';
let expenseAccount = '';
let txBlocked = '';
let txFine = '';

async function acct(code: string, name: string, type: string, subtype: string, normal: string) {
  const r = await admin.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
       account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1,$2,$3,$4,$5,$6,true,true) RETURNING id`,
    [COMPANY, code, name, type, subtype, normal]);
  return r.rows[0].id as string;
}

describeIfDb('K-140 one failed row must not abort the whole auto-post sweep', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'K140 Sweep Fixture',true)`, [COMPANY]);
    bankAccount = await acct('1000', 'K140 Bank', 'asset', 'bank', 'debit');
    expenseAccount = await acct('6000', 'K140 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'K140 AP', 'liability', 'payable', 'credit');
    await admin.query(
      `INSERT INTO gl_fiscal_periods (company_id, period_name, start_date, end_date, status)
       VALUES ($1,'K140 2026-03','2026-03-01','2026-03-31','open')
       ON CONFLICT DO NOTHING`, [COMPANY]).catch(() => undefined);
    await admin.query(
      `INSERT INTO bank_auto_post_settings
         (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
       VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [COMPANY]);

    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status,
          suggested_gl_account_id, suggested_confidence, suggested_strategy)
       VALUES ($1,$2,'2026-03-10',-100,'K140 blocked row','imported',$3,0.99,'history'),
              ($1,$2,'2026-03-11',-200,'K140 healthy row','imported',$3,0.99,'history')
       RETURNING id`, [COMPANY, bankAccount, expenseAccount]);
    txBlocked = tx.rows[0].id;
    txFine = tx.rows[1].id;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_auto_post_settings WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_auto_post_runs WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_fiscal_periods WHERE company_id = $1', [COMPANY]).catch(() => undefined);
    // Written by the allocation the sweep now actually completes.
    // gl_account_balances carries no company_id of its own — it is reached
    // through the account it belongs to.
    await admin.query(
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)',
      [COMPANY]);
    await admin.query('DELETE FROM fiscal_periods WHERE company_id = $1', [COMPANY]).catch(() => undefined);
    await admin.query('DELETE FROM gl_fiscal_years WHERE company_id = $1', [COMPANY]).catch(() => undefined);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('posts the rows it can when a peer holds one of them', async () => {
    // A concurrent request holding the first row, exactly as another allocate
    // would. Nothing about this is exotic — it is the case bankTxLock's
    // lock_timeout exists for.
    const blocker: PoolClient = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [txBlocked]);

    const req: PoolClient = await admin.connect();
    await req.query('BEGIN');
    let result;
    try {
      result = await als.run(
        { client: req, userId: USER, companyId: COMPANY, claims: {} } as never,
        () => sweep(COMPANY, [txBlocked, txFine], 'categorization', USER),
      );
      await req.query('COMMIT');
    } finally {
      req.release();
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    // No row may be skipped because a DIFFERENT row poisoned the transaction.
    // Asserted first: the reason text is the direct evidence of the mechanism.
    expect(result!.skipped.map(s => `${s.txId} :: ${s.reason}`).join(' | '))
      .not.toMatch(/current transaction is aborted|25P02/i);
    // The healthy row is unrelated to the locked one and must post.
    expect(result!.posted).toBe(1);
    expect(result!.skipped).toHaveLength(1);
    expect(result!.skipped[0]!.txId).toBe(txBlocked);

    // And the post must have survived the COMMIT.
    const after = await admin.query(
      'SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1', [txFine]);
    expect(after.rows[0].status).toBe('allocated');
  }, 60000);

  // Adjacent case: the blocked row is now the SECOND one, so the savepoint has
  // to roll back a row that comes AFTER the run was minted. The run row and its
  // posted_count must still describe what the sweep really did.
  it('leaves the run row agreeing with what actually posted when a later row fails', async () => {
    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status,
          suggested_gl_account_id, suggested_confidence, suggested_strategy)
       VALUES ($1,$2,'2026-03-12',-300,'K140 second healthy','imported',$3,0.99,'history'),
              ($1,$2,'2026-03-13',-400,'K140 second blocked','imported',$3,0.99,'history')
       RETURNING id`, [COMPANY, bankAccount, expenseAccount]);
    const good = tx.rows[0].id as string;
    const bad = tx.rows[1].id as string;

    const blocker: PoolClient = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [bad]);

    const req: PoolClient = await admin.connect();
    await req.query('BEGIN');
    let result;
    try {
      result = await als.run(
        { client: req, userId: USER, companyId: COMPANY, claims: {} } as never,
        () => sweep(COMPANY, [good, bad], 'categorization', USER),
      );
      await req.query('COMMIT');
    } finally {
      req.release();
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    expect(result!.posted).toBe(1);
    expect(result!.skipped.map(sk => sk.txId)).toEqual([bad]);

    const run = await admin.query(
      'SELECT posted_count, total_amount FROM bank_auto_post_runs WHERE id = $1', [result!.runId]);
    expect(Number(run.rows[0].posted_count)).toBe(1);
    expect(Number(run.rows[0].total_amount)).toBeCloseTo(300, 2);

    // The rolled-back row keeps no tag pointing at a run it is not part of.
    const badRow = await admin.query(
      'SELECT status, auto_post_run_id FROM bank_transactions WHERE id = $1', [bad]);
    expect(badRow.rows[0].status).toBe('imported');
    expect(badRow.rows[0].auto_post_run_id).toBeNull();
  }, 60000);

  // Adjacent case: a row the gate declines for its OWN reason (no suggested
  // account) must not be turned into a transaction-level failure by the
  // savepoint, and must not stop the row after it.
  it('still skips a row with no target and posts the one after it', async () => {
    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status,
          suggested_gl_account_id, suggested_confidence, suggested_strategy)
       VALUES ($1,$2,'2026-03-14',-500,'K140 no target','imported',NULL,0.99,'history'),
              ($1,$2,'2026-03-15',-600,'K140 after no target','imported',$3,0.99,'history')
       RETURNING id`, [COMPANY, bankAccount, expenseAccount]);
    const noTarget = tx.rows[0].id as string;
    const after = tx.rows[1].id as string;

    const req: PoolClient = await admin.connect();
    await req.query('BEGIN');
    let result;
    try {
      result = await als.run(
        { client: req, userId: USER, companyId: COMPANY, claims: {} } as never,
        () => sweep(COMPANY, [noTarget, after], 'categorization', USER),
      );
      await req.query('COMMIT');
    } finally {
      req.release();
    }

    expect(result!.posted).toBe(1);
    expect(result!.skipped.map(sk => sk.txId)).toEqual([noTarget]);
    expect(result!.skipped[0]!.reason).not.toMatch(/current transaction is aborted|25P02/i);
    const row = await admin.query('SELECT status FROM bank_transactions WHERE id = $1', [after]);
    expect(row.rows[0].status).toBe('allocated');
  }, 60000);
});
