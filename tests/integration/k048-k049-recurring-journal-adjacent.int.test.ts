/**
 * K-048 / K-049 adjacent cases for the recurring-journal generate path.
 *
 * The RED tests pin the two headline defects: a not-yet-due template posted on
 * demand, and a 400 that committed the journal it claimed had failed. These pin
 * the neighbours of both — the cases a narrower fix would leave open.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import action from '../../pages/api/accounting/recurring-journals-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { generateJournalFromRecurring } from '../../src/modules/accounting/services/gl/recurringJournalService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), otherCompany = crypto.randomUUID();
const admin = crypto.randomUUID();
const debitAccount = crypto.randomUUID(), creditAccount = crypto.randomUUID();
const template = crypto.randomUUID();
let adminToken = '';

const lines = JSON.stringify([
  { glAccountId: debitAccount, debit: 1000, credit: 0, description: 'K048 adjacent DR' },
  { glAccountId: creditAccount, debit: 0, credit: 1000, description: 'K048 adjacent CR' },
]);

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K048 adjacent fixture'),($2,'K048 adjacent peer')", [company, otherCompany]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K048A-6000','K048A Rent expense','expense','debit',3,true),
            ($3,$2,'K048A-2000','K048A Accruals','liability','credit',3,true)`,
    [debitAccount, company, creditAccount],
  );
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     SELECT $1,'K048A ' || to_char(d,'Mon YYYY'), EXTRACT(MONTH FROM d)::int, EXTRACT(YEAR FROM d)::int,
            d, (d + INTERVAL '1 month - 1 day')::date, 'open'
     FROM generate_series(date_trunc('year', CURRENT_DATE) - INTERVAL '12 months',
                          date_trunc('year', CURRENT_DATE) + INTERVAL '23 months', INTERVAL '1 month') d`,
    [company],
  );
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

/** Re-arm the template as due today, with a clean GL, before each case. */
async function armTemplate(nextRunDate: string, endDate: string | null = null) {
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,end_date,lines,total_amount,created_by,status)
     VALUES($1,$2,'K048A monthly accrual','K048A monthly accrual','monthly',$3::date,$4::date,$5::jsonb,1000,$6,'active')`,
    [template, company, nextRunDate, endDate, lines, admin],
  );
}

afterEach(async () => {
  await pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1', [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it('two concurrent generations of the same due run produce exactly one journal', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await armTemplate(today);

  const results = await Promise.allSettled([
    generateJournalFromRecurring(company, template, admin),
    generateJournalFromRecurring(company, template, admin),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

  const posted = await pool.query(
    "SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(posted.rows[0].n).toBe(1);

  // The schedule advanced exactly one interval, and the run counted once.
  const { rows } = await pool.query('SELECT run_count, next_run_date FROM recurring_journals WHERE id=$1', [template]);
  expect(Number(rows[0].run_count)).toBe(1);
  expect(String(rows[0].next_run_date) > today).toBe(true);
});

it('another tenant cannot generate this template, and does not advance it', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await armTemplate(today);

  await expect(generateJournalFromRecurring(otherCompany, template, admin)).rejects.toThrow(/not found/i);

  const { rows } = await pool.query('SELECT run_count, next_run_date, status FROM recurring_journals WHERE id=$1', [template]);
  expect(Number(rows[0].run_count)).toBe(0);
  expect(String(rows[0].next_run_date)).toBe(today);
  expect(rows[0].status).toBe('active');
  const posted = await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [company]);
  expect(posted.rows[0].n).toBe(0);
});

it('an overdue run posts into the period it was scheduled for, not today', async () => {
  const scheduled = new Date();
  scheduled.setUTCMonth(scheduled.getUTCMonth() - 2);
  scheduled.setUTCDate(1);
  const scheduledDate = scheduled.toISOString().slice(0, 10);
  await armTemplate(scheduledDate);

  const journalId = await generateJournalFromRecurring(company, template, admin);
  const { rows } = await pool.query(
    `SELECT je.entry_date::text AS entry_date, je.status, fp.start_date::text AS period_start
     FROM gl_journal_entries je LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
     WHERE je.id=$1 AND je.company_id=$2`, [journalId, company]);
  expect(rows[0].entry_date).toBe(scheduledDate);
  expect(rows[0].status).toBe('posted');
  expect(rows[0].period_start).toBe(scheduledDate);

  // And the journal balances, debit against credit, on its own lines.
  const sums = await pool.query(
    'SELECT COALESCE(SUM(debit),0)::numeric AS dr, COALESCE(SUM(credit),0)::numeric AS cr FROM gl_journal_lines WHERE journal_entry_id=$1 AND company_id=$2',
    [journalId, company]);
  expect(Number(sums.rows[0].dr)).toBe(1000);
  expect(Number(sums.rows[0].cr)).toBe(1000);
});

it('a failure AFTER the journal is written rolls the write back and answers 500', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await armTemplate(today);
  // Deactivating the credit account makes postJournalEntry throw
  // InactiveAccountError — a fault raised after createJournalEntry has already
  // INSERTed the entry and its lines. That is the K-049 class beyond the
  // closed-period instance: it must not be reported as a 400 that commits.
  await pool.query('UPDATE gl_accounts SET is_active=false WHERE id=$1', [creditAccount]);

  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/recurring-journals-action';
  req.query = {};
  req.body = { action: 'generate', id: template };
  const result = response();
  await action(req as never, result.res);

  expect(result.state.statusCode).toBe(500);

  const { rows } = await pool.query(
    "SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(rows).toHaveLength(0);
  const lineRows = await pool.query('SELECT id FROM gl_journal_lines WHERE company_id=$1', [company]);
  expect(lineRows.rows).toHaveLength(0);

  // The claim is rolled back with it, so the run is still due.
  const tpl = await pool.query('SELECT run_count, next_run_date::text AS next_run_date FROM recurring_journals WHERE id=$1', [template]);
  expect(Number(tpl.rows[0].run_count)).toBe(0);
  expect(tpl.rows[0].next_run_date).toBe(today);
});

it('a closed period is refused as a 400 BEFORE any write, not a 500 after one', async () => {
  // Close the period two months back and schedule the run into it. Without the
  // pre-check, postJournalEntry raises ClosedFiscalPeriodError after the entry
  // is already INSERTed; the route then rethrows it as a 500 and the request
  // rolls back — correct, but a logged incident for what is a user error. The
  // pre-check makes it a refusal with the remedy in it and nothing written.
  const scheduled = new Date();
  scheduled.setUTCMonth(scheduled.getUTCMonth() - 2);
  scheduled.setUTCDate(1);
  const scheduledDate = scheduled.toISOString().slice(0, 10);
  await armTemplate(scheduledDate);
  await pool.query(
    "UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND start_date <= $2::date AND end_date >= $2::date",
    [company, scheduledDate]);

  try {
    const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
      url: string; body: unknown; query: Record<string, string>;
    };
    req.url = '/api/accounting/recurring-journals-action';
    req.query = {};
    req.body = { action: 'generate', id: template };
    const result = response();
    await action(req as never, result.res);

    expect(result.state.statusCode).toBe(400);
    const { rows } = await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1', [company]);
    expect(rows).toHaveLength(0);
    const tpl = await pool.query('SELECT run_count FROM recurring_journals WHERE id=$1', [template]);
    expect(Number(tpl.rows[0].run_count)).toBe(0);
  } finally {
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1", [company]);
  }
});

it('a malformed action still refuses with 400 and writes nothing', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await armTemplate(today);

  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/recurring-journals-action';
  req.query = {};
  req.body = { action: 'generate' };
  const result = response();
  await action(req as never, result.res);

  expect(result.state.statusCode).toBe(400);
  const posted = await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [company]);
  expect(posted.rows[0].n).toBe(0);
});

it('the last run before end_date completes the template instead of leaving it active', async () => {
  const today = new Date();
  const todayDate = today.toISOString().slice(0, 10);
  // end_date sits before the next interval, so this run is the final one.
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 5);
  await armTemplate(todayDate, end.toISOString().slice(0, 10));

  await generateJournalFromRecurring(company, template, admin);
  const { rows } = await pool.query('SELECT status FROM recurring_journals WHERE id=$1', [template]);
  expect(rows[0].status).toBe('completed');

  // A completed template refuses a further generate rather than posting again.
  await expect(generateJournalFromRecurring(company, template, admin)).rejects.toThrow(/not active/i);
  const posted = await pool.query(
    "SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(posted.rows[0].n).toBe(1);
});
