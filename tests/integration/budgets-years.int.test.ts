/**
 * listBudgetYears on real PostgreSQL: the stored years (a label may be skipped
 * after a change of year end), the year holding today, and the one after the
 * last of those, oldest first. Synthetic company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { listBudgetYears } from '@/modules/accounting/services/core/budgetYears';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companyId = crypto.randomUUID();

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDY co', 3)`, [companyId]);
  // A 14-month transition year labelled 2026, then label 2028: label 2027 is skipped.
  const years = [[2026, '2026-01-01', '2027-02-28', 'transition'], [2028, '2027-03-01', '2028-02-29', 'normal']] as const;
  for (const [label, start, end, kind] of years) {
    await pool.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5)`,
      [companyId, label, start, end, kind]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  } finally { await pool.end(); }
});

const summary = (years: Awaited<ReturnType<typeof listBudgetYears>>) =>
  years.map((y) => [y.fiscalYear, y.startDate, y.endDate, y.monthKeys.length]);

describe('listBudgetYears', () => {
  it('lists the stored years with their gap, then the year after the last', async () => {
    const years = await listBudgetYears(companyId, '2026-06-15');
    expect(summary(years)).toEqual([
      [2026, '2026-01-01', '2027-02-28', 14],
      [2028, '2027-03-01', '2028-02-29', 12],
      [2029, '2028-03-01', '2029-02-28', 12],
    ]);
    expect(years[0]!.kind).toBe('transition');
    expect(years[0]!.monthKeys[13]).toBe('2027-02');
  });

  it('adds the year holding today when no stored year does, and the one after it', async () => {
    const years = await listBudgetYears(companyId, '2030-05-01');
    expect(summary(years)).toEqual([
      [2026, '2026-01-01', '2027-02-28', 14],
      [2028, '2027-03-01', '2028-02-29', 12],
      [2031, '2030-03-01', '2031-02-28', 12],
      [2032, '2031-03-01', '2032-02-29', 12],
    ]);
  });
});
