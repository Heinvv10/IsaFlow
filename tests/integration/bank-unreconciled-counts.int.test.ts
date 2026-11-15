// The "unreconciled" bank-line counts on the bank-account card (bank_accounts_status, the bank_accounts export), the
// workbench / attention panel and the bureau cockpit share ONE line predicate (#1308 follow-up, bank/unreconciledLineSql):
// a posted statement line that is neither reconciled (a completed reconciliation, or the Sage import) nor excluded.
// Review is a stamp now (mig 980), so a reviewed line is still unreconciled until a reconciliation completes; a
// 'matched' line is too. They do NOT count over the same accounts: the card is per account, over leaf bank-subtype
// accounts only (inactive ones only on request); the company totals count every posted line of the company. The last
// case pins that difference.
//
// Fixture, one bank account (all posted unless noted):
//   A  imported                                  → unreconciled (New)
//   P  provisional                               → unreconciled
//   B  allocated (own journal), not reviewed     → unreconciled (New)
//   R  allocated, reviewed                       → unreconciled (Reviewed, Not Reconciled)
//   C  matched, not reviewed                     → unreconciled (New)    — the old counts left it out
//   D  matched, reviewed                         → unreconciled (Reviewed, Not Reconciled) — likewise
//   K  reconciled on a completed reconciliation  → reconciled
//   S  reconciled in the Sage import (no recon)  → reconciled
//   X  excluded                                  → neither
//   N  imported, feed_state pending              → not on the statement yet
//   M  imported, feed_state removed              → gone
// Another company's imported line proves each count stays in its tenant.
// A third company has one imported line on each account the card does not show: a rollup bank account (it has a bank
// child), an inactive bank account and a non-bank account; plus an allocated line on the leaf child.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { getUnreconciledBankTxns } from '@/modules/accounting/services/dashboard/workbenchService';
import { aggregateBureauWork, type CompanyMeta } from '@/modules/bureau/services/bureauWorkAggregatorService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const [company, other, user, bank, otherBank, contra, period, conn, recon] =
  [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const L = { A: uuid(), P: uuid(), B: uuid(), R: uuid(), C: uuid(), D: uuid(), K: uuid(), S: uuid(), X: uuid(),
  N: uuid(), M: uuid(), O: uuid() };
const AMOUNT: Record<keyof typeof L, number> = { A: 1, P: -2, B: 4, R: -8, C: 16, D: -32, K: 64, S: 128, X: 256,
  N: 512, M: 1024, O: 2048 };
const UNRECONCILED = [L.A, L.P, L.B, L.R, L.C, L.D];
const [shapes, rollup, leaf, inactive, nonBank] = [uuid(), uuid(), uuid(), uuid(), uuid()];

async function journal(amount: number): Promise<string> {
  const je = uuid();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
     VALUES($1,$2,'2025-06-03','unreconciled fixture','posted',$3,$4,NOW(),$3)`, [je, company, user, period]);
  const jl = uuid();
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,$5,0),($6,$2,$3,$7,0,$5)`, [jl, company, je, bank, Math.abs(amount), uuid(), contra]);
  return jl;
}

async function line(key: keyof typeof L, status: string, o: {
  journal?: boolean; reviewed?: boolean; recon?: string; feed?: string; co?: string; acct?: string;
} = {}) {
  const feed = o.feed ?? 'posted';
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,
       matched_journal_line_id,reviewed_at,reconciliation_id,allocation_type,feed_state,bank_feed_connection_id,
       provider_transaction_id)
     VALUES($1,$2,$3,'2025-06-03',$4,'unreconciled fixture',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [L[key], o.co ?? company, o.acct ?? bank, AMOUNT[key], status, o.journal ? await journal(AMOUNT[key]) : null,
      o.reviewed ? new Date() : null, o.recon ?? null, status === 'allocated' ? 'account' : null, feed,
      feed === 'posted' ? null : conn, feed === 'posted' ? null : `unrec-${key}`]);
}

describe('one unreconciled population for the bank card, the workbench and the bureau', () => {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
      [company, 'Unreconciled fixture', other, 'Unreconciled other']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'UC Jun',1,2025,'2025-06-01','2025-06-30','open')`, [period, company]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$4,'UCB','UC Bank','asset','bank','debit'),($2,$4,'UCC','UC Contra','revenue',NULL,'credit'),
             ($3,$5,'UCO','UC Other Bank','asset','bank','debit')`, [bank, contra, otherBank, company, other]);
    await pool.query(
      `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
       VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
    await pool.query(
      `INSERT INTO bank_reconciliations(id,company_id,bank_account_id,statement_date,status,started_by,completed_by,completed_at)
       VALUES($1,$2,$3,'2025-06-30','completed',$4,$4,NOW())`, [recon, company, bank, user]);
    await line('A', 'imported');
    await line('P', 'provisional');
    await line('B', 'allocated', { journal: true });
    await line('R', 'allocated', { journal: true, reviewed: true });
    await line('C', 'matched', { journal: true });
    await line('D', 'matched', { journal: true, reviewed: true });
    await line('K', 'reconciled', { journal: true, reviewed: true, recon });
    await line('S', 'reconciled');
    await line('X', 'excluded');
    await line('N', 'imported', { feed: 'pending' });
    await line('M', 'imported', { feed: 'removed' });
    await line('O', 'imported', { co: other, acct: otherBank });
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [shapes, 'Unreconciled shapes']);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
       VALUES($1,$4,'USR','US Rollup','asset','bank','debit',true),($2,$4,'USI','US Inactive','asset','bank','debit',false),
             ($3,$4,'USN','US Not bank','asset',NULL,'debit',true)`, [rollup, inactive, nonBank, shapes]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,parent_account_id)
       VALUES($1,$2,'USL','US Leaf','asset','bank','debit',$3)`, [leaf, shapes, rollup]);
    for (const [acct, status] of [[rollup, 'imported'], [inactive, 'imported'], [nonBank, 'imported'], [leaf, 'allocated']]) {
      await pool.query(
        `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status,allocation_type)
         VALUES($1,$2,'2025-06-03',5,'unreconciled shapes',$3,$4)`,
        [shapes, acct, status, status === 'allocated' ? 'account' : null]);
    }
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1::uuid[])', [[company, other, shapes]]);
      await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, contra, otherBank]]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[rollup, leaf, inactive, nonBank]]);
      await pool.query('UPDATE gl_accounts SET parent_account_id=NULL WHERE company_id=$1', [shapes]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [[company, other, shapes]]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, other, shapes]]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally { await pool.end(); }
  });

  it('the bank-account card counts every posted line not reconciled and not excluded', async () => {
    const rows = await getBankAccountsStatus(company, { includeInactive: true });
    expect(rows.find((r) => r.id === bank)?.unreconciledCount).toBe(UNRECONCILED.length);
  });

  it('the workbench / attention count uses the same predicate, in this company only', async () => {
    expect(await getUnreconciledBankTxns(company)).toBe(UNRECONCILED.length);
    expect(await getUnreconciledBankTxns(other)).toBe(1);
  });

  it('the bureau cockpit says the same count and sums the same lines', async () => {
    const meta = new Map<string, CompanyMeta>([
      [company, { bureau_id: uuid(), bureau_name: 'UC Bureau', company_id: company, company_name: 'UC Client' }],
    ]);
    const { items } = await aggregateBureauWork([company], meta, new Date());
    const recon = items.filter((i) => i.task === 'Bank reconciliation');
    expect(recon).toHaveLength(1);
    expect(recon[0]).toMatchObject({ companyId: company, detail: `${UNRECONCILED.length} unreconciled` });
    const keys = Object.keys(L) as Array<keyof typeof L>;
    const total = keys.filter((k) => UNRECONCILED.includes(L[k])).reduce((s, k) => s + Math.abs(AMOUNT[k]), 0);
    expect(recon[0]!.amount).toBe(total);
  });

  it('is exactly the posted lines on New, Reviewed > Not Reconciled and Provisional, and none on Reconciled', async () => {
    const tab = async (status: string, reconFilter?: 'unreconciled' | 'reconciled') =>
      (await getBankTransactions(company, { bankAccountId: bank, status, reconFilter, limit: 100 }))
        .transactions.filter((t) => t.feedState === 'posted').map((t) => t.id);
    const open = [...await tab('imported'), ...await tab('matched', 'unreconciled'), ...await tab('provisional')];
    expect(open.sort()).toEqual([...UNRECONCILED].sort());
    expect((await tab('matched', 'reconciled')).sort()).toEqual([L.K, L.S].sort());
  });

  it('the card counts per leaf bank account; the company totals count every posted line (intended difference)', async () => {
    const sum = (rows: Awaited<ReturnType<typeof getBankAccountsStatus>>) => rows.reduce((n, r) => n + r.unreconciledCount, 0);
    const all = await getBankAccountsStatus(shapes, { includeInactive: true });
    // The rollup and the non-bank account have no card; the leaf and (on request) the inactive account do.
    expect(all.map((r) => r.id).sort()).toEqual([leaf, inactive].sort());
    expect(sum(all)).toBe(2);
    expect(sum(await getBankAccountsStatus(shapes))).toBe(1);
    expect(await getUnreconciledBankTxns(shapes)).toBe(4);
    const meta = new Map<string, CompanyMeta>([
      [shapes, { bureau_id: uuid(), bureau_name: 'US Bureau', company_id: shapes, company_name: 'US Client' }],
    ]);
    const { items } = await aggregateBureauWork([shapes], meta, new Date());
    expect(items.find((i) => i.task === 'Bank reconciliation')?.detail).toBe('4 unreconciled');
  });
});
