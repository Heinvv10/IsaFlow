/**
 * K-140 (review M-5) — RED before the fix. `undoRun` carried the SAME defect
 * K-140 was raised for, in the sibling file the K-140 commit did not touch.
 *
 * Its per-row `try/catch` had no savepoint, and the body calls
 * `reverseReconciledTransaction` / `reverseJournalEntry`, which post contra
 * journals and take row locks under a 5s `lock_timeout`. A contended row raises
 * a real Postgres error inside the request transaction; the catch swallowed it
 * while the transaction stayed ABORTED, so every later row failed 25P02 and the
 * trailing `UPDATE bank_auto_post_runs … undone` threw — making the catch's own
 * log line, "run will still be marked undone; manual reversal required for this
 * tx", false in exactly the case it describes.
 *
 * K-071 r19: that claim is now deliberately NOT made. This test used to assert
 * the run was marked undone despite the skipped row; a skipped row is still
 * posted and still tagged, so "undone" there would read as "fully reversed"
 * while it is not. The run stays open, and a retry picks up the tagged row
 * (docs/audits/remediation/K-071/fix.md, round 19).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount = '';

async function makeRun(): Promise<string> {
  const r = await admin.query(
    `INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
     VALUES ($1,'categorization',0.9,0,$2) RETURNING id`, [COMPANY, USER]);
  return r.rows[0].id as string;
}

/** A row carrying the run's tag with nothing left to reverse — the `alreadyUndone` shape. */
async function taggedRow(runId: string, desc: string, amount: number): Promise<string> {
  const r = await admin.query(
    `INSERT INTO bank_transactions
       (company_id, bank_account_id, transaction_date, amount, description, status, auto_post_run_id)
     VALUES ($1,$2,'2026-03-10',$3,$4,'imported',$5) RETURNING id`,
    [COMPANY, bankAccount, amount, desc, runId]);
  return r.rows[0].id as string;
}

describeIfDb('K-140 M-5 one failed row must not abort the whole undo', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K140 Undo Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','K140 Undo Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;
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

  it('clears the rows it can and leaves the run open when a peer holds one', async () => {
    const runId = await makeRun();
    // The blocked row carries a matched line, so `reverseReconciledTransaction`
    // is called and its very first statement — the FOR UPDATE — is what fails.
    // No downstream state is needed: the error is raised before any write.
    const je = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
       VALUES ($1,'2026-03-10','K140 undo entry','posted',$2) RETURNING id`, [COMPANY, USER]);
    const jl = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,0,100,'K140 undo line') RETURNING id`, [COMPANY, je.rows[0].id, bankAccount]);
    const blockedRow = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status,
          auto_post_run_id, matched_journal_line_id)
       VALUES ($1,$2,'2026-03-10',-100,'K140 undo blocked','matched',$3,$4) RETURNING id`,
      [COMPANY, bankAccount, runId, jl.rows[0].id]);
    const blocked = blockedRow.rows[0].id as string;
    const healthy = await taggedRow(runId, 'K140 undo healthy', -200);

    const blocker: PoolClient = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [blocked]);

    const req: PoolClient = await admin.connect();
    await req.query('BEGIN');
    let result;
    try {
      result = await als.run(
        { client: req, userId: USER, companyId: COMPANY, claims: {} } as never,
        () => undoRun(COMPANY, runId, USER),
      );
      await req.query('COMMIT');
    } finally {
      req.release();
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    // The blocked row is the only casualty; nothing else is lost to 25P02.
    expect(result!).toEqual({ reversed: 0, skipped: 1, alreadyUndone: 1, undone: false });

    // Not undone: the blocked row still carries the run — read after COMMIT.
    const run = await admin.query(
      'SELECT undone_at FROM bank_auto_post_runs WHERE id = $1 AND company_id = $2', [runId, COMPANY]);
    expect(run.rows[0].undone_at).toBeNull();

    const rows = await admin.query(
      'SELECT id, auto_post_run_id FROM bank_transactions WHERE id = ANY($1)', [[healthy, blocked]]);
    const byId = Object.fromEntries(rows.rows.map((r: { id: string; auto_post_run_id: string | null }) =>
      [r.id, r.auto_post_run_id]));
    expect(byId[healthy]).toBeNull();      // the untouched row was cleared
    expect(byId[blocked]).toBe(runId);     // the failed row rolled back alone
  }, 60000);

  // Adjacent case: with nothing contended the counts must be unchanged by the
  // savepoint — a stale tag is cleared and counted as alreadyUndone, never as a
  // reversal, because `reversed` is the number the operator reconciles against.
  it('counts a run of stale tags as alreadyUndone, not reversed', async () => {
    const runId = await makeRun();
    await taggedRow(runId, 'K140 stale a', -10);
    await taggedRow(runId, 'K140 stale b', -20);

    const req: PoolClient = await admin.connect();
    await req.query('BEGIN');
    let result;
    try {
      result = await als.run(
        { client: req, userId: USER, companyId: COMPANY, claims: {} } as never,
        () => undoRun(COMPANY, runId, USER),
      );
      await req.query('COMMIT');
    } finally {
      req.release();
    }

    expect(result!).toEqual({ reversed: 0, skipped: 0, alreadyUndone: 2, undone: true });
  }, 60000);
});
