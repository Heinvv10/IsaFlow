/**
 * Round-2 adversarial repros for PR #807: attacks on the FIXES at 1077eb862.
 * Each test asserts the invariant; red = finding. Rolled back. Synthetic data.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getFiscalRange, getFiscalRangeWithPrior } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { ensureFiscalPeriodForDate } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
afterAll(async () => { await pool.end(); });

async function inRolledBackTx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
async function attempt(c: PoolClient, fn: () => Promise<unknown>) {
  await c.query('SAVEPOINT attack');
  try { await fn(); await c.query('RELEASE SAVEPOINT attack'); return null; } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT attack');
    return e as { code?: string; message: string };
  }
}
const inAls = <T>(c: PoolClient, co: string, fn: () => Promise<T>) =>
  als.run({ client: c, companyId: co, userId: crypto.randomUUID(), claims: {} } as never, fn);
async function company(c: PoolClient, fyStart: number | null = 3) {
  const id = crypto.randomUUID();
  await c.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BRK807B', $2)`, [id, fyStart]);
  return id;
}
async function year(c: PoolClient, co: string, date: string, status = 'open') {
  const y = (await c.query('SELECT public.fiscal_year_ensure($1, $2) AS id', [co, date])).rows[0].id as string;
  await c.query('SELECT public.fiscal_periods_generate($1)', [y]);
  if (status !== 'open') await c.query('UPDATE fiscal_periods SET status = $2 WHERE fiscal_year_id = $1', [y, status]);
  return y;
}
async function asAppUser(c: PoolClient, userId: string, companyId: string) {
  await c.query('SET LOCAL ROLE app_user');
  await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)`,
    [JSON.stringify({ sub: userId }), companyId]);
}
async function postedJournal(c: PoolClient, co: string, date: string) {
  const user = crypto.randomUUID();
  await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@t.local`]);
  const [a1, a2] = [crypto.randomUUID(), crypto.randomUUID()];
  await c.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, $4, 'bank', 'asset', 'debit', 3, true), ($2, $3, $5, 'sales', 'revenue', 'credit', 3, true)`,
    [a1, a2, co, `B-${a1.slice(0, 6)}`, `S-${a2.slice(0, 6)}`]);
  const je = (await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status)
     VALUES ($1, $2, $3, 'brk807b', 'draft') RETURNING id, fiscal_period_id`, [co, date, user])).rows[0];
  await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
                 VALUES ($1, $2, 100, 0, $4), ($1, $3, 0, 100, $4)`, [je.id, a1, a2, co]);
  await c.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [je.id]);
  return je as { id: string; fiscal_period_id: string };
}
/** The readers suite's own shape: a January year end changed to February via a 14-month transition year. */
async function changedYearEnd(c: PoolClient) {
  const co = await company(c, 3);
  const fy25 = (await c.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date)
    VALUES ($1, 2025, '2025-01-01', '2025-12-31') RETURNING id`, [co])).rows[0].id;
  const fy26 = (await c.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
    VALUES ($1, 2026, '2026-01-01', '2027-02-28', 'transition') RETURNING id`, [co])).rows[0].id;
  for (const id of [fy25, fy26]) await c.query('SELECT public.fiscal_periods_generate($1)', [id]);
  return co;
}

describe('R3-A — assumed_start does not propagate: a year chained from an assumed year is flagged declared', () => {
  it('the AFS refuses every year built on the assumed March start, not just the first', async () => {
    await inRolledBackTx(async (c) => {
      const co = await company(c, null);
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'Jan 2026', 1, 2026, '2026-01-01', '2026-01-31')`, [co]);
      // The write path that "refuses a company with no usable financial_year_start":
      const gen = await attempt(c, () => c.query(`SELECT public.fiscal_year_ensure($1, '2026-06-01')`, [co]));
      const yrs = (await c.query(`SELECT fiscal_year, start_date::text s, assumed_start FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`, [co])).rows;
      const afs27 = await inAls(c, co, () => getFiscalRange(co, 2027)).catch((e: Error) => e.name);
      // Fix chosen: the assumption carries forward — the generator builds the next
      // year (postings keep working) but flags it assumed, so the AFS refuses it.
      expect({ generatorRefused: gen !== null, yrs, afs27 }).toEqual({
        generatorRefused: false,
        yrs: [{ fiscal_year: 2026, s: '2025-03-01', assumed_start: true }, { fiscal_year: 2027, s: '2026-03-01', assumed_start: true }],
        afs27: 'StartMonthAssumedError' });
    });
  });
});

describe('R3-B — assumed_start is never cleared: declaring the month the years already use leaves the AFS blocked', () => {
  it('after the company declares March (what its assumed years use), the AFS renders', async () => {
    await inRolledBackTx(async (c) => {
      const co = await company(c, null);
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'Jan 2026', 1, 2026, '2026-01-01', '2026-01-31')`, [co]);
      // What updateCompany does for financialYearStart=3 (assertFinancialYearStartChange normalises NULL to 3: "no change").
      await c.query(`UPDATE companies SET financial_year_start = COALESCE(3, financial_year_start) WHERE id = $1`, [co]);
      const r = await inAls(c, co, () => getFiscalRange(co, 2026)).catch((e: Error) => e.name);
      expect(r).toEqual({ start: '2025-03-01', end: '2026-02-28' });
    });
  });
});
