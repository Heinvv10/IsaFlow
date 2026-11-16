// Tenant fence on the transaction views: the shared bank-transaction SELECT's GL join (account name) and the
// bank-query list's join to the line and its GL account. A line pointing at another company's GL account must not
// borrow that account's name, and a query pointing at another company's line must not list it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { listQueries } from '@/modules/accounting/services/capture/bankTxQueryService';
import { getReconciliationById } from '@/modules/accounting/services/bank/bankReconciliationService';
import { matchFromHistoryBulk } from '@/modules/accounting/services/core/smartCategorizationMatchingService';
import { bankLine, dropCompanies, seedCompanies, uuid, type FenceCompanies } from './helpers/bankFenceFixture';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
let c: FenceCompanies;
let userId = '';
const ids = { own: '', onForeignGl: '', foreignLine: '', suggestedForeign: '', history: '' };
const [period, je, recId] = [uuid(), uuid(), uuid()];

async function query(company: string, tx: string) {
  await pool.query(
    `INSERT INTO bank_tx_queries(id,company_id,bank_transaction_id,to_number,message_body) VALUES($1,$2,$3,'+27000000000','fence')`,
    [uuid(), company, tx]);
}

describeIfDb('bank tenant fence — transaction views', () => {
  beforeAll(async () => {
    c = await seedCompanies(pool);
    ids.own = await bankLine(pool, c.a, c.bankA, '2025-04-10', 100);
    ids.onForeignGl = await bankLine(pool, c.a, c.bankB, '2025-04-11', 200); // A's line on B's GL account
    ids.foreignLine = await bankLine(pool, c.b, c.bankB, '2025-04-12', 300); // B's own line
    // A's line whose SUGGESTED account is B's GL account.
    ids.suggestedForeign = await bankLine(pool, c.a, c.bankA, '2025-04-13', 400);
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id=$2 WHERE id=$1', [ids.suggestedForeign, c.bankB]);
    // A history line (matched to a journal line) suggesting B's GL account.
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'Fence Apr',1,2025,'2025-04-01','2025-04-30','open')`, [period, c.a]);
    const user = uuid();
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
       VALUES($1,$2,'2025-04-14','fence history','posted',$3,$4,NOW(),$3)`, [je, c.a, user, period]);
    const line = uuid();
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$3,$4,$5,100,0),($2,$3,$4,$5,0,100)`, [line, uuid(), c.a, je, c.bankA]);
    ids.history = await bankLine(pool, c.a, c.bankA, '2025-04-14', -100);
    await pool.query(
      `UPDATE bank_transactions SET status='matched', matched_journal_line_id=$2, suggested_gl_account_id=$3,
         description='FENCEHIST WIDGETS' WHERE id=$1`, [ids.history, line, c.bankB]);
    userId = user;
    // A's reconciliation session on B's GL account.
    await pool.query(
      `INSERT INTO bank_reconciliations(id,company_id,bank_account_id,statement_date,statement_balance,gl_balance,reconciled_balance,status,started_by)
       VALUES($1,$2,$3,'2025-04-30',0,0,0,'in_progress',$4)`, [recId, c.a, c.bankB, user]);
    await query(c.a, ids.own);
    await query(c.a, ids.onForeignGl);
    await query(c.a, ids.foreignLine); // A's query pointing at B's line
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [c.a]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [c.a]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [c.a]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [c.a]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[c.bankA, c.bankB]]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [c.a]);
      await dropCompanies(pool, c);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
      await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[c.a, c.b]]);
    } finally {
      await pool.end();
    }
  });

  it("the transaction list shows the GL account name only for this company's own account", async () => {
    const { transactions } = await getBankTransactions(c.a);
    const name = (id: string) => transactions.find((t) => t.id === id)?.bankAccountName;
    expect(transactions.map((t) => t.id).sort()).toEqual([ids.own, ids.onForeignGl, ids.suggestedForeign, ids.history].sort());
    expect(name(ids.own)).toBe('Fence A Bank');
    expect(name(ids.onForeignGl)).toBeUndefined();
    // The suggested-account name is another company's: not shown.
    expect(transactions.find((t) => t.id === ids.suggestedForeign)?.suggestedGlAccountName).toBeUndefined();
  });

  it("the query list drops a query that points at another company's line and names no foreign account", async () => {
    const rows = await listQueries(c.a);
    const by = new Map(rows.map((r) => [String(r.bank_transaction_id), r]));
    expect([...by.keys()].sort()).toEqual([ids.own, ids.onForeignGl].sort());
    expect(by.get(ids.own)!.bank_account_name).toBe('Fence A Bank');
    expect(by.get(ids.onForeignGl)!.bank_account_name).toBeNull();
  });

  it("the historical categoriser names no GL account of another company", async () => {
    const res = await matchFromHistoryBulk(c.a, [{ txId: 't1', description: 'FENCEHIST WIDGETS', amount: -100 }]);
    const hit = res.get('t1');
    expect(hit?.glAccountId).toBe(c.bankB); // the stored suggestion is what history learned
    expect(hit?.glAccountName).toBeUndefined();
    expect(hit?.glAccountCode).toBeUndefined();
  });

  it("a reconciliation on another company's GL account is read without that account's name", async () => {
    const rec = await getReconciliationById(c.a, recId);
    expect(rec?.id).toBe(recId);
    expect(rec?.bankAccountName).toBeUndefined();
  });
});
