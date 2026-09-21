/**
 * K-046 RED: the year-end close crashes on any P&L account carrying a contra
 * balance.
 *
 * yearEndCloseService.ts:145 measures a revenue account as credit - debit, so a
 * revenue account with a net DEBIT balance comes back negative.
 * yearEndJournalBuilder.ts:70-73 puts that signed number straight into the
 * line's `debit` with no Math.abs and no side swap, and
 * gl_journal_lines_debit_check forbids a negative debit. The whole close
 * transaction aborts, so the year can never be closed.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const revenue = crypto.randomUUID();
const bank = crypto.randomUUID();
const retained = crypto.randomUUID();
const period = crypto.randomUUID();
const entry = crypto.randomUUID();

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)", [company, 'K046 company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `k046-${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'4000','Sales','revenue',NULL,'credit',true,false),
           ($3,$2,'1000','Bank','asset',NULL,'debit',true,false),
           ($4,$2,'3200','Retained Earnings','equity','retained_earnings','credit',true,true)`,
    [revenue, company, bank, retained]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2025',1,2025,'2025-01-01','2025-12-31','closed')`,
    [period, company]);
  // A revenue account left with a net DEBIT balance: a refund/reversal larger
  // than what was billed to that account in the year.
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,'K046-JE-1','2025-06-30',$3,'Revenue reversal','manual','posted',$4,$4,now())`,
    [entry, company, period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,500,0,'Revenue reversal',$4),($1,$3,0,500,'Refund paid',$4)`,
    [entry, revenue, bank, company]);
  clearSystemAccountCache(company);
});

afterAll(async () => {
  clearSystemAccountCache(company);
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query(
      'DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)',
      [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('previews the contra revenue account as a credit, never a negative debit', async () => {
  const dry = await closeFiscalYear(company, '2025', user, { dryRun: true }) as
    { preview: { lines: Array<{ accountCode: string; debit: number; credit: number }> } };
  // RED: the builder puts the signed balance straight into `debit`.
  expect(dry.preview.lines[0]).toMatchObject({ accountCode: '4000', debit: 0, credit: 500 });
});

it('is rejected by gl_journal_lines_debit_check when that line is written', async () => {
  const dry = await closeFiscalYear(company, '2025', user, { dryRun: true }) as
    { preview: { lines: Array<{ accountId: string; debit: number; credit: number }> } };
  const line = dry.preview.lines[0]!;
  const client = await pool.connect();
  let raised: { code?: string; constraint?: string } | null = null;
  try {
    await client.query('BEGIN');
    const header = await client.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by)
       VALUES($1,'K046-YE','2025-12-31',$2,'Year-End Closing: 2025','manual','posted',$3) RETURNING id`,
      [company, period, user]);
    await client.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,$3,$4,'Year-end close',$5)`,
      [header.rows[0].id, line.accountId, line.debit, line.credit, company]);
  } catch (err) {
    raised = err as { code?: string; constraint?: string };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  // RED: the close's own line is illegal.
  expect(raised).toBeNull();
});

it('uses a journal source the gl_journal_entries CHECK constraint accepts', async () => {
  // RED (blocker found while validating K-046): postClosingJournal writes
  // source='year_end', which gl_journal_entries_source_check does not allow, so
  // EVERY year-end close fails at the header insert before reaching the lines.
  await expect(closeFiscalYear(company, '2025', user)).resolves.toMatchObject({ netIncome: -500 });
});
