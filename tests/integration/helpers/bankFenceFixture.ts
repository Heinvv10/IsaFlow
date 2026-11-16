/**
 * Shared by the bank tenant-fence suites: two companies, each with a bank-subtype GL account. The fence
 * bank_transactions.bank_account_id -> gl_accounts(id) is on the id alone, so a line can point at ANOTHER
 * company's GL account, and RLS does not hide it for the pool role.
 */
import type { Pool } from 'pg';

export const uuid = () => crypto.randomUUID();

export interface FenceCompanies { a: string; b: string; bankA: string; bankB: string }

export async function seedCompanies(pool: Pool, a = uuid()): Promise<FenceCompanies> {
  const [b, bankA, bankB] = [uuid(), uuid(), uuid()];
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING', [a, `Fence A ${a}`]);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [b, `Fence B ${b}`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$3,'FNA','Fence A Bank','asset','bank','debit'),($2,$4,'FNB','Fence B Bank','asset','bank','debit')`,
    [bankA, bankB, a, b]);
  return { a, b, bankA, bankB };
}

/** A posted bank line of `company` on GL account `account` (which may belong to another company). */
export async function bankLine(pool: Pool, company: string, account: string, date: string, amount: number): Promise<string> {
  const id = uuid();
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,$4::DATE,$5,'fence fixture','imported')`, [id, company, account, date, amount]);
  return id;
}

export async function dropCompanies(pool: Pool, c: FenceCompanies): Promise<void> {
  for (const co of [c.a, c.b]) {
    await pool.query('DELETE FROM bank_tx_queries WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
  }
  await pool.query('DELETE FROM bank_transactions WHERE bank_account_id=ANY($1::uuid[])', [[c.bankA, c.bankB]]);
  await pool.query('DELETE FROM gl_accounts WHERE id=ANY($1::uuid[])', [[c.bankA, c.bankB]]);
}
