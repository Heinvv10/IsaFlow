/**
 * K-048 round 2, HIGH 1 — the `no_period` pre-check must not reverse the repo's
 * auto-create policy.
 *
 * Nothing creates fiscal periods when a company is provisioned, so a brand-new
 * tenant has ZERO rows and every date falls outside every period. The posting
 * path handles that by CREATING the year (`ensureFiscalPeriodForDate`, called
 * from `createJournalEntry`), never by refusing. A pre-check that answered a
 * plain SELECT therefore turned a template that posted yesterday into a dead
 * Generate button for any company whose fiscal year nobody had created by hand.
 *
 * Its own fixture because the point is a company with no `fiscal_periods` rows,
 * which the shared adjacent fixture deliberately does not have.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inRequestTx } from './recurringJournalRequestTx.helpers';
import { generateJournalFromRecurring } from '../../src/modules/accounting/services/gl/recurringJournalService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const debitAccount = crypto.randomUUID(), creditAccount = crypto.randomUUID();
const template = crypto.randomUUID();

const lines = JSON.stringify([
  { glAccountId: debitAccount, debit: 1000, credit: 0, description: 'K048F accrual DR' },
  { glAccountId: creditAccount, debit: 0, credit: 1000, description: 'K048F accrual CR' },
]);

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K048F no-periods fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K048F-6000','K048F Rent expense','expense','debit',3,true),
            ($3,$2,'K048F-2000','K048F Accruals','liability','credit',3,true)`,
    [debitAccount, company, creditAccount],
  );
  // No fiscal_periods rows at all — the ordinary provisioned state.
});

async function armTemplate(nextRunDate: string) {
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,lines,total_amount,created_by,status)
     VALUES($1,$2,'K048F monthly accrual','K048F monthly accrual','monthly',$3::date,$4::jsonb,1000,$5,'active')`,
    [template, company, nextRunDate, lines, user],
  );
}

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('generates for a company that has no fiscal periods, creating the year instead of refusing', async () => {
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await armTemplate(today);

  const none = await pool.query('SELECT id FROM fiscal_periods WHERE company_id=$1', [company]);
  expect(none.rows).toHaveLength(0);

  const journalId = await inRequestTx(pool, company, user,
    () => generateJournalFromRecurring(company, template, user));

  // Posted, dated at the run date, and INSIDE a period — a NULL fiscal_period_id
  // is the hazard the guard exists for, and creating the year is what avoids it.
  const je = await pool.query(
    `SELECT je.status, je.entry_date::text AS entry_date, je.fiscal_period_id,
            fp.status AS period_status
     FROM gl_journal_entries je LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
     WHERE je.id=$1 AND je.company_id=$2`, [journalId, company]);
  expect(je.rows[0].status).toBe('posted');
  expect(je.rows[0].entry_date).toBe(today);
  expect(je.rows[0].fiscal_period_id).not.toBeNull();
  expect(je.rows[0].period_status).toBe('open');

  // And it balances.
  const sums = await pool.query(
    'SELECT COALESCE(SUM(debit),0)::numeric AS dr, COALESCE(SUM(credit),0)::numeric AS cr FROM gl_journal_lines WHERE journal_entry_id=$1 AND company_id=$2',
    [journalId, company]);
  expect(Number(sums.rows[0].dr)).toBe(1000);
  expect(Number(sums.rows[0].cr)).toBe(1000);

  const created = await pool.query('SELECT id FROM fiscal_periods WHERE company_id=$1', [company]);
  expect(created.rows.length).toBeGreaterThan(0);
});

it('still refuses a run date whose year is outside the auto-create window', async () => {
  // Fifteen years back is well beyond AUTO_CREATE_YEARS_BACK — far enough that
  // no period alignment can pull the date's FISCAL year back inside the window
  // — so nothing would be created and the entry would post with a NULL
  // fiscal_period_id, invisible to the trial balance, the VAT201 and the AFS.
  // That is the case the refusal is for, and the only one it should keep.
  const year = new Date().getUTCFullYear() - 15;
  const runDate = `${year}-06-15`;
  await armTemplate(runDate);

  await expect(
    inRequestTx(pool, company, user, () => generateJournalFromRecurring(company, template, user)),
  ).rejects.toThrow(/too far from today to be created automatically/i);

  const je = await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1', [company]);
  expect(je.rows).toHaveLength(0);
  const tpl = await pool.query('SELECT run_count FROM recurring_journals WHERE id=$1', [template]);
  expect(Number(tpl.rows[0].run_count)).toBe(0);
  const periods = await pool.query(
    'SELECT id FROM fiscal_periods WHERE company_id=$1 AND start_date <= $2::date AND end_date >= $2::date',
    [company, runDate]);
  expect(periods.rows).toHaveLength(0);
});
