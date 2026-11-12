// Reconciled bank lines stay on the Reviewed tab; review is a stamped fact (migration 980); a reconciliation cannot
// complete while a line it reconciles is unreviewed; a reconciled line's dimensions and documents are locked
// (Hein, 2026-11-12).
//
// Fixture, one bank account, statement 2025-06-30:
//   A  imported                                   → New
//   B  allocated (own journal), not reviewed      → New; claimed and self-matched by the session
//   C  matched to a journal, not reviewed         → New (as a match on the recon screen leaves it)
//   D  matched, reviewed                          → Reviewed (not reconciled)
//   S  reconciled in the Sage import (no recon)   → Reviewed (reconciled)
//   X  excluded                                   → Excluded
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  startReconciliation, completeReconciliation, getBankTransactions,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { reopenReconciliation } from '@/modules/accounting/services/bank/bankReconciliationReopenService';
import { bulkAcceptTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { ReconciliationReviewRequiredError } from '@/modules/accounting/services/bank/reconciliationReviewGate';
import { ReconciliationCompletedError } from '@/modules/accounting/services/bank/reconciliationSessionLock';
import { saveBankTxDimensions } from '@/modules/accounting/services/bank/bankTxAnnotations';
import { documentRemovalRefused, isReconciledLine, ReconciledCashError } from '@/modules/accounting/services/bank/reconciledCash';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import { rejectCapturedDocument } from '@/modules/accounting/services/capture/captureRejectService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
// `viewer` reads the list: a different member than the reviewer, as RLS on users hides everyone but yourself.
const [company, user, viewer, bank, contra, period] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const L = { A: uuid(), B: uuid(), C: uuid(), D: uuid(), S: uuid(), X: uuid() };
let recId = '';

async function journal(date: string, amount: number): Promise<string> {
  const je = uuid();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
     VALUES($1,$2,$3::DATE,'review fixture','posted',$4,$5,NOW(),$4)`, [je, company, date, user, period]);
  const line = uuid();
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,$5,0),($6,$2,$3,$7,0,$5)`, [line, company, je, bank, amount, uuid(), contra]);
  return line;
}

async function line(id: string, date: string, amount: number, status: string, jl: string | null, reviewed = false) {
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,
       matched_journal_line_id,reviewed_at,allocation_type)
     VALUES($1,$2,$3,$4::DATE,$5,'review fixture',$6,$7,$8,$9)`,
    [id, company, bank, date, amount, status, jl, reviewed ? new Date() : null, status === 'allocated' ? 'account' : null]);
}

/** As a real request runs: app_user under RLS, with the session's user and company GUCs. */
async function asAppUser<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)",
      [JSON.stringify({ sub: viewer }), company]);
    return await als.run({ client, userId: viewer, companyId: company, claims: {} }, fn);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

const ids = async (status: string, reconFilter?: 'unreconciled' | 'reconciled') =>
  (await getBankTransactions(company, { bankAccountId: bank, status, reconFilter, limit: 100 }))
    .transactions.map((t) => t.id).sort();
const sorted = (...xs: string[]) => [...xs].sort();
const row = async (id: string) => (await pool.query(
  'SELECT status, reviewed_at, reviewed_by::TEXT AS reviewed_by FROM bank_transactions WHERE id=$1', [id])).rows[0];

describe('bank lines: review stamp, tabs, completion gate, reconciled lock', () => {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Review fixture']);
    await pool.query("INSERT INTO users(id,email,role,is_active,first_name,last_name) VALUES($1,$2,'admin',true,'Rita','Reviewer')", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)", [viewer, `${viewer}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer')", [company, user, viewer]);
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'RV Jun',1,2025,'2025-06-01','2025-06-30','open')`, [period, company]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'RVB','RV Bank','asset','bank','debit'),($2,$3,'RVC','RV Contra','revenue',NULL,'credit')`,
      [bank, contra, company]);
    await line(L.A, '2025-06-02', 10, 'imported', null);
    await line(L.B, '2025-06-03', 300, 'allocated', await journal('2025-06-03', 300));
    await line(L.C, '2025-06-04', 20, 'matched', await journal('2025-06-04', 20));
    await line(L.D, '2025-06-05', 30, 'matched', null, true);
    await line(L.S, '2025-05-20', 40, 'reconciled', null);
    await line(L.X, '2025-06-06', 50, 'excluded', null);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, contra]]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[user, viewer]]);
    } finally { await pool.end(); }
  });

  it('New holds unreviewed lines; Reviewed holds reviewed and reconciled ones (Sage included)', async () => {
    expect(await ids('imported')).toEqual(sorted(L.A, L.B, L.C));
    expect(await ids('matched')).toEqual(sorted(L.D, L.S));
    expect(await ids('matched', 'reconciled')).toEqual([L.S]);
    expect(await ids('matched', 'unreconciled')).toEqual([L.D]);
    expect(await ids('excluded')).toEqual([L.X]);
  });

  it('the trigger clears the stamp when a line goes back to imported or excluded, and keeps it otherwise', async () => {
    const t = uuid();
    await line(t, '2025-06-07', 1, 'matched', null, true);
    await pool.query("UPDATE bank_transactions SET status='allocated' WHERE id=$1", [t]);
    expect((await row(t)).reviewed_at).not.toBeNull();
    await pool.query("UPDATE bank_transactions SET status='imported' WHERE id=$1", [t]);
    expect((await row(t)).reviewed_at).toBeNull();
    await pool.query("UPDATE bank_transactions SET status='matched', reviewed_at=NOW() WHERE id=$1", [t]);
    await pool.query("UPDATE bank_transactions SET status='excluded' WHERE id=$1", [t]);
    expect((await row(t)).reviewed_at).toBeNull();
    await pool.query('DELETE FROM bank_transactions WHERE id=$1', [t]);
  });

  it('completion refuses while a line it would reconcile is unreviewed, and writes nothing', async () => {
    const r = await startReconciliation(company, bank, '2025-06-30', 320, user);
    recId = r.id;
    expect(r.selfMatched).toBe(1);
    const err = await completeReconciliation(company, recId, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconciliationReviewRequiredError);
    // Only B blocks: A is in the session too but unallocated (it would not be reconciled), so it does not count.
    expect((await pool.query('SELECT reconciliation_id::TEXT AS r FROM bank_transactions WHERE id=$1', [L.A])).rows[0].r).toBe(recId);
    expect((err as ReconciliationReviewRequiredError).unreviewed).toBe(1);
    expect((await row(L.B)).status).toBe('allocated');
    const [h] = (await pool.query('SELECT status FROM bank_reconciliations WHERE id=$1', [recId])).rows;
    expect(h.status).toBe('in_progress');
  });

  it('an unallocated line cannot be reviewed: no journal carries its cash (it stays on New)', async () => {
    expect(await inRequest(() => bulkAcceptTransactions(company, [L.A], user))).toBe(0);
    expect(await row(L.A)).toMatchObject({ status: 'imported', reviewed_at: null });
  });

  it('review stamps who and when and leaves status alone; the line moves to Reviewed; completion then reconciles it', async () => {
    expect(await inRequest(() => bulkAcceptTransactions(company, [L.B], user))).toBe(1);
    expect(await row(L.B)).toMatchObject({ status: 'allocated', reviewed_by: user });
    expect((await row(L.B)).reviewed_at).not.toBeNull();
    expect(await ids('matched')).toEqual(sorted(L.B, L.D, L.S));
    const done = await completeReconciliation(company, recId, user);
    expect(done.status).toBe('completed');
    expect((await row(L.B)).status).toBe('reconciled');
    expect(await ids('matched', 'reconciled')).toEqual(sorted(L.B, L.S));
    const [t] = (await asAppUser(() => getBankTransactions(company, { bankAccountId: bank, status: 'matched', reconFilter: 'reconciled' })))
      .transactions.filter((x) => x.id === L.B);
    expect(t).toMatchObject({ reconciliationId: recId, reconStatus: 'completed', reconStatementDate: '2025-06-30',
      reviewedBy: user, reviewedByName: 'Rita Reviewer' });
  });

  it('a reconciled line refuses dimension changes and document removal; a reviewed one does not', async () => {
    const err = await inRequest(() => saveBankTxDimensions(company, L.S, {}, user)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconciledCashError);
    const inSession = await inRequest(() => saveBankTxDimensions(company, L.B, {}, user)).catch((e: unknown) => e);
    expect(inSession).toBeInstanceOf(ReconciliationCompletedError); // the shared 409: its reconciliation is completed
    await expect(inRequest(() => saveBankTxDimensions(company, L.D, {}, user))).resolves.toBe(true);
    await expect(inRequest(() => saveBankTxDimensions(company, uuid(), {}, user))).resolves.toBe(false);
    expect(await inRequest(() => isReconciledLine(company, { bankTxId: L.B }))).toBe(true);
    // Removing a document: a line of a completed session is the shared 409; a Sage-reconciled one is refused here.
    const removal = await inRequest(() => documentRemovalRefused(company, { bankTxId: L.B })).catch((e: unknown) => e);
    expect(removal).toBeInstanceOf(ReconciliationCompletedError);
    expect(await inRequest(() => documentRemovalRefused(company, { bankTxId: L.S }))).toBe(true);
    expect(await inRequest(() => documentRemovalRefused(company, { bankTxId: L.D }))).toBe(false);
    expect(await inRequest(() => isReconciledLine(company, { bankTxId: L.D }))).toBe(false);
  });

  it('a document cannot be moved off a reconciled line; it can be moved off a reviewed one', async () => {
    const doc = async (onLine: string) => {
      const id = uuid();
      await pool.query(
        `INSERT INTO captured_documents(id,company_id,file_name,file_type,file_size,status,matched_bank_tx_id,
           storage_bucket,storage_path)
         VALUES($1,$2,'slip.pdf','application/pdf',10,'matched',$3,'captured-documents',$4)`,
        [id, company, onLine, `${company}/${id}.pdf`]);
      return id;
    };
    const held = await doc(L.B);
    expect(await inRequest(() => attachCapturedDocToBankTx(company, held, L.D, user)))
      .toEqual({ ok: false, reason: 'previous_line_reconciled' });
    const [still] = (await pool.query('SELECT matched_bank_tx_id::TEXT AS t FROM captured_documents WHERE id=$1', [held])).rows;
    expect(still.t).toBe(L.B);
    // Rejecting it would drop it from the line's documents too: refused, nothing written.
    expect(await inRequest(() => rejectCapturedDocument(company, held, 'not ours'))).toEqual({ refused: 'reconciled_line' });
    expect((await pool.query('SELECT status FROM captured_documents WHERE id=$1', [held])).rows[0].status).toBe('matched');
    const free = await doc(L.D);
    expect(await inRequest(() => attachCapturedDocToBankTx(company, free, L.C, user))).toMatchObject({ ok: true });
    expect(await inRequest(() => rejectCapturedDocument(company, free, null))).toMatchObject({ row: { status: 'rejected' } });
    await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id=ANY($1::uuid[])', [[L.C, L.D]]);
    await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [[held, free]]);
  });

  it('reopening the reconciliation keeps the review: the line stays on Reviewed', async () => {
    await inRequest(() => reopenReconciliation(company, recId, user, { reason: 'review fixture' }));
    expect(await row(L.B)).toMatchObject({ status: 'allocated', reviewed_by: user });
    expect(await ids('matched', 'unreconciled')).toEqual(sorted(L.B, L.D));
    expect(await ids('imported')).toEqual(sorted(L.A, L.C));
  });

  it('Review takes a matched line nobody reviewed (matched on the recon screen) off New', async () => {
    expect(await inRequest(() => bulkAcceptTransactions(company, [L.C], user))).toBe(1);
    expect(await row(L.C)).toMatchObject({ status: 'matched', reviewed_by: user });
    expect(await ids('imported')).toEqual([L.A]);
  });

  it('a review covers the journal it was given: a re-match or a new provisional journal clears it (mig 981)', async () => {
    const t = uuid();
    await line(t, '2025-06-08', 5, 'matched', await journal('2025-06-08', 5), true);
    await pool.query('UPDATE bank_transactions SET matched_journal_line_id = $2 WHERE id = $1', [t, await journal('2025-06-08', 5)]);
    expect((await row(t)).reviewed_at).toBeNull();
    await pool.query('UPDATE bank_transactions SET reviewed_at = NOW() WHERE id = $1', [t]);
    await pool.query("UPDATE bank_transactions SET notes = 'x', status = 'matched' WHERE id = $1", [t]);
    expect((await row(t)).reviewed_at).not.toBeNull(); // same journal, same status: the review stands
    const [{ je }] = (await pool.query('SELECT journal_entry_id::TEXT AS je FROM gl_journal_lines WHERE id = $1',
      [await journal('2025-06-08', 5)])).rows;
    await pool.query('UPDATE bank_transactions SET provisional_je_id = $2 WHERE id = $1', [t, je]);
    expect((await row(t)).reviewed_at).toBeNull(); // a new provisional journal is a new pairing too
    await pool.query('DELETE FROM bank_transactions WHERE id=$1', [t]);
  });

  it('a Sage-reconciled line cannot be matched, unmatched or excluded (it has no session to reopen)', async () => {
    const jl = await journal('2025-06-20', 40);
    const err = await inRequest(() => matchTransaction(company, L.S, jl, undefined, user)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconciledCashError);
    const un = await inRequest(() => unmatchTransaction(company, L.S, user)).catch((e: unknown) => e);
    expect(un).toBeInstanceOf(ReconciledCashError);
    const ex = await inRequest(() => excludeTransaction(company, L.S, 'dup', user)).catch((e: unknown) => e);
    expect(ex).toBeInstanceOf(ReconciledCashError);
    expect((await row(L.S)).status).toBe('reconciled');
  });

  it('migration 981 un-reviews a matched line no journal carries, and keeps every other review', async () => {
    const [orphan, real] = [uuid(), uuid()];
    await line(orphan, '2025-06-09', 6, 'matched', null, true);
    await line(real, '2025-06-09', 7, 'matched', await journal('2025-06-09', 7), true);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync('scripts/migrations/sql/981_bank_tx_review_reset_on_rematch.sql', 'utf8'));
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    expect(await row(orphan)).toMatchObject({ status: 'matched', reviewed_at: null, reviewed_by: null });
    expect((await row(real)).reviewed_at).not.toBeNull();
    expect((await row(L.D)).reviewed_at).toBeNull(); // the fixture's D has the same legacy shape: no journal
    await pool.query('DELETE FROM bank_transactions WHERE id = ANY($1::uuid[])', [[orphan, real]]);
  });
});
