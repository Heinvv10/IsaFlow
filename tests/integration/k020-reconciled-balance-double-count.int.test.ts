// K-020 RED: updateReconciledBalance adds matched bank-transaction amounts to
// the STORED gl_balance snapshot, and never reflects the adjustment journal it
// was called to record.
//   * A matched transaction confirms a GL movement that is ALREADY inside
//     gl_balance, so adding its amount counts the same movement twice.
//   * createAdjustmentEntry posts a new bank-side journal then calls this
//     helper, which recomputes from the frozen gl_balance column — the
//     adjustment never moves reconciled_balance or difference.
// Source: src/modules/accounting/services/bank/bankReconciliationService.ts:262-277
//         (call site 171, snapshot written at 78-99)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  startReconciliation,
  createAdjustmentEntry,
} from '@/modules/accounting/services/bank/bankReconciliationService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const contra = crypto.randomUUID();
const je = crypto.randomUUID();
const bankLine = crypto.randomUUID();
const contraLine = crypto.randomUUID();
const period = crypto.randomUUID();
const bankTx = crypto.randomUUID();
let reconId = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K020 recon fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'K020 Mar 2026',3,2026,DATE '2026-03-01',DATE '2026-03-31','open')`,
    [period, company],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$3,'K020B','K020 Bank','asset','bank','debit'),($2,$3,'K020C','K020 Interest','revenue',NULL,'credit')`,
    [bank, contra, company],
  );
  // A posted receipt already in the GL: bank +1000.
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
     VALUES($1,$2,DATE '2026-03-05','K020 receipt','posted',$3,$4,NOW(),$3)`,
    [je, company, user, period],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$3,$4,$5,1000,0),($2,$3,$4,$6,0,1000)`,
    [bankLine, contraLine, company, je, bank, contra],
  );
  // The statement says 1050: the same receipt plus R50 of interest not yet in the GL.
  const recon = await startReconciliation(company, bank, '2026-03-31', 1050, user);
  reconId = recon.id;
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,reconciliation_id,matched_journal_line_id)
     VALUES($1,$2,$3,DATE '2026-03-05',1000,'K020 receipt on statement','matched',$4,$5)`,
    [bankTx, company, bank, reconId, bankLine],
  );
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
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('K-020 reconciled balance', () => {
  it('reflects the adjustment journal and does not re-add matched movements', async () => {
    const before = await pool.query(
      'SELECT gl_balance, reconciled_balance, difference FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(before.rows[0].gl_balance)).toBe(1000);

    // R50 of bank interest the GL has not seen: this is exactly what an
    // adjustment entry is for, and it should close the reconciliation.
    await createAdjustmentEntry(company, reconId, bank, contra, 50, 'K020 bank interest', user);

    const after = await pool.query(
      'SELECT reconciled_balance, difference FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(after.rows[0].reconciled_balance)).toBe(1050);
    expect(Number(after.rows[0].difference)).toBe(0);
  });
});
