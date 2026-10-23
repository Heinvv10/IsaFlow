/**
 * Feature A acceptance: every reader takes a year's dates from the stored year,
 * not from the current financial_year_start. A company whose FY2025 ran
 * January-December 2025, then a 14-month transition year FY2026 (January 2026
 * - February 2027), then (template) FY2028 March 2027 - February 2028, while it
 * now DECLARES March. Deriving any year from the start month (3) gets every
 * assertion below wrong. Real PostgreSQL; all data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';
import {
  getFiscalRange, getFiscalRangeWithPrior, getPriorFiscalRange,
} from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { fiscalYearForDate, getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const co = crypto.randomUUID(), user = crypto.randomUUID();
const bank = crypto.randomUUID(), sales = crypto.randomUUID();

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, companyId: co, userId: user, claims: {} } as never, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function post(date: string, amount: number) {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
     VALUES ($1, $2, $3, 'sale', 'draft', 'manual') RETURNING id`, [co, date, user])).rows[0];
  await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
                    VALUES ($1, $2, $3, $5, 0, 'd'), ($1, $2, $4, 0, $5, 'c')`, [je.id, co, bank, sales, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [je.id, user]);
}
const periodId = async (start: string) =>
  (await pool.query('SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = $2', [co, start])).rows[0].id as string;

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYREAD co', 3)`, [co]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'R-1000', 'bank', 'asset', 'debit', 3, true), ($2, $3, 'R-4000', 'sales', 'revenue', 'credit', 3, true)`,
    [bank, sales, co]);
  const fy25 = (await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date)
    VALUES ($1, 2025, '2025-01-01', '2025-12-31') RETURNING id`, [co])).rows[0].id;
  const fy26 = (await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
    VALUES ($1, 2026, '2026-01-01', '2027-02-28', 'transition') RETURNING id`, [co])).rows[0].id;
  for (const id of [fy25, fy26]) await pool.query('SELECT public.fiscal_periods_generate($1)', [id]);
  await pool.query(`SELECT public.fiscal_periods_generate(public.fiscal_year_ensure($1, '2027-03-01'))`, [co]);
  await post('2025-06-10', 100);
  await post('2026-02-10', 200);
  await post('2027-01-10', 400);
  await post('2027-04-10', 800);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN ($1, $2)', [bank, sales]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN ($1, $2)', [bank, sales]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM companies WHERE id = $1', [co]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
});

describe('the registry', () => {
  it('answers each year by its own dates', async () => {
    await inTx(async () => {
      expect(await fiscalYearForDate(co, '2026-12-15')).toMatchObject({ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', months: 14, kind: 'transition', stored: true });
      expect(await fiscalYearForDate(co, '2025-06-01')).toMatchObject({ fiscalYear: 2025, startDate: '2025-01-01', endDate: '2025-12-31', months: 12 });
      expect(await getFiscalYear(co, 2028)).toMatchObject({ startDate: '2027-03-01', endDate: '2028-02-29' });
      // The label the transition skipped belongs to no year.
      expect(await getFiscalYear(co, 2027)).toBeNull();
      // Beyond the stored years, the template chains twelve months on.
      expect(await fiscalYearForDate(co, '2028-05-01')).toMatchObject({ fiscalYear: 2029, startDate: '2028-03-01', stored: false });
    });
  });
});

describe('trial balance year-to-date', () => {
  const salesClosing = async (periodStart: string) => {
    const rows = await inTx(async () => getTrialBalance(co, await periodId(periodStart)));
    return rows.find((r) => r.accountCode === 'R-4000')?.creditBalance ?? 0;
  };
  it('runs from the start of the 14-month transition year, not from 1 March', async () => {
    expect(await salesClosing('2027-02-01')).toBe(600); // Feb 2026 + Jan 2027
  });
  it('resets at the year after the transition', async () => {
    expect(await salesClosing('2027-04-01')).toBe(800);
  });
  it('keeps the old January-December year as it was', async () => {
    expect(await salesClosing('2025-12-01')).toBe(100);
  });
});

describe('AFS ranges', () => {
  it('the transition year with its real prior year as the comparative', async () => {
    expect(await inTx(() => getFiscalRangeWithPrior(co, 2026, true))).toEqual({
      current: { start: '2026-01-01', end: '2027-02-28' }, prior: { start: '2025-01-01', end: '2025-12-31' } });
  });
  it('the year after: comparative is the 14-month transition year', async () => {
    expect(await inTx(() => getFiscalRange(co, 2028))).toEqual({ start: '2027-03-01', end: '2028-02-29' });
    expect(await inTx(() => getPriorFiscalRange(co, 2028))).toEqual({ start: '2026-01-01', end: '2027-02-28' });
  });
});

describe('general ledger year boundary', () => {
  it('an income account opens at zero on the first day of the year after the transition', async () => {
    const rows = await inTx(() => getGeneralLedgerReport(co, '2027-03-01', '2027-04-30'));
    const s = rows.find((r) => r.accountCode === 'R-4000')!;
    expect(s.openingBalance).toBe(0);
    expect(s.closingBalance).toBe(800);
  });
  it('and carries the transition year through 31 December 2026', async () => {
    const rows = await inTx(() => getGeneralLedgerReport(co, '2027-01-01', '2027-01-31'));
    expect(rows.find((r) => r.accountCode === 'R-4000')!.openingBalance).toBe(200);
  });
});
