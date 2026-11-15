// WP2 row 3: a reconciliation completes only at a difference of exactly R0.00. R0.01 either way is refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { completeReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [company, user, bank, contra, period, je] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];

async function session(statementBalance: number): Promise<string> {
  const id = uuid();
  await pool.query(
    `INSERT INTO bank_reconciliations(id,company_id,bank_account_id,statement_date,statement_balance,
       gl_balance,reconciled_balance,status,started_by)
     VALUES($1,$2,$3,'2025-04-24',$4,0,0,'in_progress',$5)`, [id, company, bank, statementBalance, user]);
  return id;
}
const status = async (id: string) => (await pool.query(
  'SELECT status FROM bank_reconciliations WHERE id=$1', [id])).rows[0].status;

describeIfDb('bank reconciliation — completion needs exactly R0.00', () => {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Exact cents']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'EC Apr',1,2025,'2025-04-01','2025-04-30','open')`, [period, company]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'ECB','EC Bank','asset','bank','debit'),($2,$3,'ECC','EC Contra','revenue',NULL,'credit')`,
      [bank, contra, company]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
       VALUES($1,$2,'2025-04-10','exact cents','posted',$3,$4,NOW(),$3)`, [je, company, user, period]);
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$3,$4,$5,100,0),($2,$3,$4,$6,0,100)`, [uuid(), uuid(), company, je, bank, contra]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, contra]]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  });

  it.each([[100.01, '0.01'], [99.99, '-0.01']])(
    'refuses a statement of %s (difference R%s) and leaves the session in progress', async (stmt, diff) => {
      const id = await session(stmt);
      await expect(completeReconciliation(company, id, user)).rejects.toThrow(`difference is R${diff}`);
      expect(await status(id)).toBe('in_progress');
    });

  it('completes at exactly R0.00', async () => {
    const id = await session(100);
    const done = await completeReconciliation(company, id, user);
    expect(done.status).toBe('completed');
    expect(await status(id)).toBe('completed');
  });
});
