/**
 * K-143 — RED, with a corrected mechanism.
 *
 * The audit said a FAILED reversal is "counted in the total". It is not: the
 * catch at autoPostUndoService.ts:68-75 (origin/master) increments `skipped`,
 * and the run being marked undone anyway is stated in the code and the log line.
 *
 * What IS counted as a reversal is a row with nothing left to reverse. The loop
 * (lines 39-76) increments `reversed` after an if / else-if pair that both fall
 * through when the row carries neither `matched_journal_line_id` nor
 * `provisional_je_id`. All that then happens is `auto_post_run_id = NULL`.
 *
 * That row shape is produced by the product itself: `unmatchTransaction`
 * (bankTxStatusMutations.ts:96-107) and `reverseReconciledTransaction`
 * (bankAllocationService.ts:730-740) both clear `matched_journal_line_id` and
 * leave `auto_post_run_id` set. So a user who undoes one line by hand and then
 * undoes the run is told the run reversed N transactions when it reversed
 * fewer — the count the operator reconciles against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let runId = '';
let txHandUndone = '';

function inTx<T>(fn: () => Promise<T>): Promise<T> {
  return (async () => {
    const c: PoolClient = await admin.connect();
    await c.query('BEGIN');
    try {
      const out = await als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  })();
}

describeIfDb('K-143 undo must not count a row it did not reverse', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'K143 Undo Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','K143 Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    const je = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description)
       VALUES ($1,'2026-03-01',$2,'K143 fixture') RETURNING id`, [COMPANY, USER]);
    const jl = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,500,0) RETURNING id`, [COMPANY, je.rows[0].id, bank.rows[0].id]);
    const run = await admin.query(
      `INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by, posted_count, total_amount)
       VALUES ($1,'categorization',0.9,0,$2,1,500) RETURNING id`, [COMPANY, USER]);
    runId = run.rows[0].id;
    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status,
          matched_journal_line_id, auto_post_run_id)
       VALUES ($1,$2,'2026-03-01',500,'K143 auto-posted row','matched',$3,$4) RETURNING id`,
      [COMPANY, bank.rows[0].id, jl.rows[0].id, runId]);
    txHandUndone = tx.rows[0].id;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_auto_post_runs WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('does not count a row a user already undid by hand', async () => {
    // Through the product: unmatch leaves auto_post_run_id in place.
    await inTx(() => unmatchTransaction(COMPANY, txHandUndone));
    const mid = await admin.query(
      'SELECT matched_journal_line_id, auto_post_run_id FROM bank_transactions WHERE id = $1', [txHandUndone]);
    expect(mid.rows[0].matched_journal_line_id).toBeNull();
    expect(mid.rows[0].auto_post_run_id).toBe(runId);   // the stale tag the undo will read

    const result = await inTx(() => undoRun(COMPANY, runId, USER));
    expect(result.reversed).toBe(0);
    expect(result.alreadyUndone).toBe(1);
    expect(result.skipped).toBe(0);
    // The stale tag is cleared even though nothing was reversed, so a re-run
    // does not report the same phantom row twice.
    const after = await admin.query(
      'SELECT auto_post_run_id FROM bank_transactions WHERE id = $1', [txHandUndone]);
    expect(after.rows[0].auto_post_run_id).toBeNull();
  });

  // Adjacent case: a reconciled row is a SKIP, not a phantom reversal. This is
  // the branch that already worked and must keep working — the correction must
  // not push every uncounted row into the new bucket.
  it('still reports a reconciled row as skipped, not as already undone', async () => {
    const run = await admin.query(
      `INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by, posted_count, total_amount)
       VALUES ($1,'categorization',0.9,0,$2,1,900) RETURNING id`, [COMPANY, USER]);
    const otherRun = run.rows[0].id as string;
    const acct = await admin.query(
      'SELECT id FROM gl_accounts WHERE company_id = $1 LIMIT 1', [COMPANY]);
    await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status, auto_post_run_id)
       VALUES ($1,$2,'2026-03-02',900,'K143 reconciled row','reconciled',$3)`,
      [COMPANY, acct.rows[0].id, otherRun]);

    const result = await inTx(() => undoRun(COMPANY, otherRun, USER));
    expect(result.skipped).toBe(1);
    expect(result.reversed).toBe(0);
    expect(result.alreadyUndone).toBe(0);
    // K-071 r19: the reconciled row is still posted and tagged, so the run is
    // not recorded undone.
    expect(result.undone).toBe(false);
    const after = await admin.query('SELECT undone_at FROM bank_auto_post_runs WHERE id = $1', [otherRun]);
    expect(after.rows[0].undone_at).toBeNull();
  });

  // Adjacent case: another company's run id is not this company's to undo.
  it('refuses a run id belonging to another company', async () => {
    const other = randomUUID();
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'K143 Other Co',true)`, [other]);
    const run = await admin.query(
      `INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
       VALUES ($1,'categorization',0.9,0,$2) RETURNING id`, [other, USER]);
    try {
      await expect(inTx(() => undoRun(COMPANY, run.rows[0].id, USER))).rejects.toThrow(/not found/i);
    } finally {
      await admin.query('DELETE FROM bank_auto_post_runs WHERE company_id = $1', [other]);
      await admin.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });
});
