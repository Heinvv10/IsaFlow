/**
 * K-082 — IFRS 9 staging must respond to real arrears.
 *
 * assessLoan chose the reference date as the next instalment on or after the
 * assessment date, so computeDaysPastDue was always handed a future due date,
 * days past due was always 0 and every exposure stayed at stage 1 with only a
 * 12-month ECL. Assessed here against PostgreSQL with a borrower four
 * instalments in arrears and a second, paid-up tenant.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { assessLoan } from '@/modules/accounting/services/loans/loanComplianceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const user = randomUUID();
const AS_OF = '2025-06-30';

const SCHEDULE = [
  '2024-12-31', '2025-01-31', '2025-02-28', '2025-03-31',
  '2025-04-30', '2025-05-31', '2025-07-31', '2025-08-31',
];

interface Tenant { company: string; loan: string; runId: string; accountId: string }

const arrears: Tenant = { company: randomUUID(), loan: randomUUID(), runId: randomUUID(), accountId: '' };
const paidUp: Tenant = { company: randomUUID(), loan: randomUUID(), runId: randomUUID(), accountId: '' };

function run<T>(c: PoolClient, company: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
}

async function seed(t: Tenant, label: string, lastPaymentDate: string) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [t.company, `K082 ${label}`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [t.company, user]);
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,'2400',$2,'liability','long_term_liability','credit',true)
     RETURNING id`, [t.company, `${label} Loan liability`]);
  t.accountId = rows[0].id as string;
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,status)
     VALUES($1,$2,$3,500000,'2024-11-30',8,'FIXED',11,$4,'active')`,
    [t.loan, t.company, `K082-${label}`, t.accountId]);
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k082')`, [t.runId, t.loan, t.company]);
  for (let i = 0; i < SCHEDULE.length; i++) {
    await pool.query(
      `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
         lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
       VALUES($1,$2,$3,$4,11,10000,4500,5500,0,false,10000,$5,60000,false,false)`,
      [t.runId, i + 1, SCHEDULE[i], 500000 - i * 5000, 500000 - (i + 1) * 5000]);
  }
  // The last cash that actually arrived.
  await pool.query(
    `INSERT INTO loan_gl_postings(company_id,loan_id,period,posting_date,account_id,debit,credit,
       narrative,posted_period)
     VALUES($1,$2,1,$3,$4,0,10000,'payment','202501')`,
    [t.company, t.loan, lastPaymentDate, t.accountId]);
}

async function cleanup(t: Tenant) {
  await pool.query('DELETE FROM loan_compliance_assessments WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loan_gl_postings WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [t.runId]);
  await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loans WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [t.company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await seed(arrears, 'arrears', '2025-01-31');
  await seed(paidUp, 'paidup', AS_OF);
});

afterAll(async () => {
  try {
    await cleanup(arrears);
    await cleanup(paidUp);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function assess(t: Tenant) {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await run(c, t.company, () => assessLoan(t.company, t.loan, user, AS_OF));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

it('stages a borrower four instalments in arrears at stage 3', async () => {
  const assessment = await assess(arrears);
  // 28 February to 30 June 2025 is 122 days.
  expect(assessment.daysPastDue).toBe(122);
  expect(assessment.stage).toBe(3);
  // Stage 3 carries the full outstanding as the loss allowance, not the 12m ECL.
  expect(assessment.eclMethod).toBe('full');
  expect(assessment.eclAmount).toBeGreaterThan(0);
});

it('persists the days past due it reports', async () => {
  const { rows } = await pool.query(
    `SELECT days_past_due, ifrs9_stage FROM loan_compliance_assessments
      WHERE company_id=$1 AND loan_id=$2 ORDER BY assessed_at DESC LIMIT 1`,
    [arrears.company, arrears.loan]);
  expect(Number(rows[0].days_past_due)).toBe(122);
  expect(Number(rows[0].ifrs9_stage)).toBe(3);
});

it('leaves a paid-up borrower in the second tenant at stage 1', async () => {
  const assessment = await assess(paidUp);
  expect(assessment.daysPastDue).toBe(0);
  expect(assessment.stage).toBe(1);

  // The arrears tenant recorded exactly one assessment; nothing crossed over.
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM loan_compliance_assessments WHERE company_id=$1',
    [arrears.company]);
  expect(rows[0].n).toBe(1);
});
