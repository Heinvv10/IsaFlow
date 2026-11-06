import type { PoolClient } from 'pg';

/**
 * A posted journal whose operating cash splits into FRACTIONS of a cent: 1.00 of cash in, against 2.00 of fixed asset
 * bought and 3.00 of sales, payables and payroll credited. The asset leg draws no cash (it runs against the cash), so the
 * 1.00 is shared over customers, suppliers and employees at 0.3333.. each. Rounded apart that is 0.33 x 3 = 0.99: it is the
 * residue handling and the cent rounding of the direct statement that put 1.00 back, in whole-cent lines.
 */
export async function seedFractionalCashJournal(c: PoolClient, companyId: string, bankId: string, userId: string, date: string): Promise<void> {
  const acct = async (code: string, type: string, subtype: string, normal: string) => (await c.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 3, true) RETURNING id`, [companyId, code, `Fraction ${code}`, type, subtype, normal])).rows[0].id as string;
  const fa = await acct('FR-1', 'asset', 'fixed_asset', 'debit');
  const sales = await acct('FR-2', 'revenue', 'sales', 'credit');
  const payable = await acct('FR-3', 'liability', 'payable', 'credit');
  const payroll = await acct('FR-4', 'liability', 'payroll_liability', 'credit');
  const je = (await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
     VALUES ($1, 'MP-FRACTION-1', $2, 'fractions of a cent', 'manual', 'draft', $3) RETURNING id`, [companyId, date, userId])).rows[0].id as string;
  for (const [account, debit, credit] of [[bankId, 1, 0], [fa, 2, 0], [sales, 0, 1], [payable, 0, 1], [payroll, 0, 1]] as const) {
    await c.query('INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)', [companyId, je, account, debit, credit]);
  }
  await c.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [je]);
}
