/**
 * A bank reconciliation adjustment may not post its contra to AP or AR control.
 *
 * The adjustment is a manual journal: DR/CR the bank and DR/CR an account the
 * person names. Named as AP or AR control, it moves the control with no payment
 * or receipt document behind it, so the subledger drifts from the control by
 * the amount (bank/contactControlGuard, as #711/#720 refused every other bank
 * posting path). Refused before anything is written. The remedy is a supplier
 * payment or customer receipt, reconciled in the ordinary way. An adjustment to
 * an ordinary account still posts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createAdjustmentEntry, startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const ap = crypto.randomUUID();
const ar = crypto.randomUUID();
const charges = crypto.randomUUID();
const period = crypto.randomUUID();
let reconId = '';

async function countEntries(): Promise<number> {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [company]);
  return r.rows[0].n as number;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Recon adjustment control fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'RAC Mar 2026',3,2026,DATE '2026-03-01',DATE '2026-03-31','open')`, [period, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance) VALUES
       ($1,$5,'RACB','RAC Bank','asset','bank','debit'),
       ($2,$5,'RACAP','RAC Trade Creditors','liability','Accounts Payable','credit'),
       ($3,$5,'RACAR','RAC Trade Debtors','asset','receivable','debit'),
       ($4,$5,'RACBC','RAC Bank Charges','expense',NULL,'debit')`,
    [bank, ap, ar, charges, company]);
  reconId = (await startReconciliation(company, bank, '2026-03-31', 0, user)).id;
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, ap, ar, charges]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('a reconciliation adjustment onto AP/AR control', () => {
  it.each([
    ['AP control', () => ap, -120, /accounts payable control account: name the supplier/],
    ['AR control', () => ar, 80, /accounts receivable control account: name the customer/],
  ])('refuses %s before anything is written', async (_what, account, amount, message) => {
    const before = await countEntries();
    await expect(createAdjustmentEntry(company, reconId, bank, account(), amount, 'RAC adjustment', user)).rejects.toThrow(message);
    expect(await countEntries()).toBe(before);
  });

  it('still posts an adjustment to an ordinary account', async () => {
    const before = await countEntries();
    const je = await createAdjustmentEntry(company, reconId, bank, charges, -15, 'RAC bank charges', user);
    expect(je).toBeTruthy();
    expect(await countEntries()).toBe(before + 1);
  });
});
