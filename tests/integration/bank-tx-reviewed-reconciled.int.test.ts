// Reconciled bank lines stay on the Reviewed tab; review is a stamped fact (migration 980); a reconciliation cannot
// complete while a line it reconciles is unreviewed; a reconciled line's dimensions and documents are locked
// (Hein, 2026-11-12).
//
// Fixture, one bank account, statement 2025-06-30:
//   A  imported                                   → New
//   B  allocated (own journal), not reviewed      → New; claimed and self-matched by the session
//   C  matched, not reviewed                      → New
//   D  matched, reviewed                          → Reviewed (not reconciled)
//   S  reconciled in the Sage import (no recon)   → Reviewed (reconciled)
//   X  excluded                                   → Excluded
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  startReconciliation, completeReconciliation, getBankTransactions,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { reopenReconciliation } from '@/modules/accounting/services/bank/bankReconciliationReopenService';
import { bulkAcceptTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { ReconciliationReviewRequiredError } from '@/modules/accounting/services/bank/reconciliationReviewGate';
import { isReconciledLine, saveBankTxDimensions } from '@/modules/accounting/services/bank/bankTxAnnotations';
import { ReconciledCashError } from '@/modules/accounting/services/bank/reconciledCash';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const [company, user, bank, contra, period] = [uuid(), uuid(), uuid(), uuid(), uuid()];
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
       matched_journal_line_id,reviewed_at)
     VALUES($1,$2,$3,$4::DATE,$5,'review fixture',$6,$7,$8)`,
    [id, company, bank, date, amount, status, jl, reviewed ? new Date() : null]);
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
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'RV Jun',1,2025,'2025-06-01','2025-06-30','open')`, [period, company]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'RVB','RV Bank','asset','bank','debit'),($2,$3,'RVC','RV Contra','revenue',NULL,'credit')`,
      [bank, contra, company]);
    await line(L.A, '2025-06-02', 10, 'imported', null);
    await line(L.B, '2025-06-03', 300, 'allocated', await journal('2025-06-03', 300));
    await line(L.C, '2025-06-04', 20, 'matched', null);
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
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
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
    const r = await startReconciliation(company, bank, '2025-06-30', 300, user);
    recId = r.id;
    expect(r.selfMatched).toBe(1);
    const err = await completeReconciliation(company, recId, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconciliationReviewRequiredError);
    expect((err as ReconciliationReviewRequiredError).unreviewed).toBe(1);
    expect((await row(L.B)).status).toBe('allocated');
    const [h] = (await pool.query('SELECT status FROM bank_reconciliations WHERE id=$1', [recId])).rows;
    expect(h.status).toBe('in_progress');
  });

  it('review stamps who and when; the line moves to Reviewed; completion then reconciles it', async () => {
    expect(await inRequest(() => bulkAcceptTransactions(company, [L.B], user))).toBe(1);
    expect(await row(L.B)).toMatchObject({ status: 'matched', reviewed_by: user });
    expect((await row(L.B)).reviewed_at).not.toBeNull();
    expect(await ids('matched')).toEqual(sorted(L.B, L.D, L.S));
    const done = await completeReconciliation(company, recId, user);
    expect(done.status).toBe('completed');
    expect((await row(L.B)).status).toBe('reconciled');
    expect(await ids('matched', 'reconciled')).toEqual(sorted(L.B, L.S));
    const [t] = (await getBankTransactions(company, { bankAccountId: bank, status: 'matched', reconFilter: 'reconciled' }))
      .transactions.filter((x) => x.id === L.B);
    expect(t).toMatchObject({ reconciliationId: recId, reconStatus: 'completed', reconStatementDate: '2025-06-30',
      reviewedBy: user, reviewedByName: `${user}@test.local` });
  });

  it('a reconciled line refuses dimension changes and document removal; a reviewed one does not', async () => {
    const err = await inRequest(() => saveBankTxDimensions(company, L.S, {}, user)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconciledCashError);
    await expect(inRequest(() => saveBankTxDimensions(company, L.D, {}, user))).resolves.toBeUndefined();
    expect(await inRequest(() => isReconciledLine(company, { bankTxId: L.B }))).toBe(true);
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
    const free = await doc(L.D);
    expect(await inRequest(() => attachCapturedDocToBankTx(company, free, L.C, user))).toMatchObject({ ok: true });
    await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id=ANY($1::uuid[])', [[L.C, L.D]]);
    await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [[held, free]]);
  });

  it('reopening the reconciliation keeps the review: the line stays on Reviewed', async () => {
    await inRequest(() => reopenReconciliation(company, recId, user, { reason: 'review fixture' }));
    expect(await row(L.B)).toMatchObject({ status: 'matched', reviewed_by: user });
    expect(await ids('matched', 'unreconciled')).toEqual(sorted(L.B, L.D));
    expect(await ids('imported')).toEqual(sorted(L.A, L.C));
  });
});
