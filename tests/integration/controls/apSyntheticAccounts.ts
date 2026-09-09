import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
export async function seedApAccounts(pool: Pool, companyId: string) {
  const accounts = { payable: randomUUID(), bank: randomUUID(), vat_input: randomUUID(), default_expense: randomUUID() };
  for (const [role, id] of Object.entries(accounts)) {
    const type = role === 'payable' ? 'liability' : role === 'default_expense' ? 'expense' : 'asset';
    await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
      VALUES($1,$2,$3,$4,$5,$6,$7,true,true)`, [id, companyId, id.slice(0, 12), `Synthetic ${role}`, type, role, type === 'liability' ? 'credit' : 'debit']);
  }
  return accounts;
}
