/**
 * Budget vs Actual for a CHOSEN financial year (optional `fiscal_year` on the
 * report route and its CSV export): the label is resolved through the registry,
 * a label no year carries is a 404, anything that is not a label is a 400, and
 * the window is that year's own range (14 months for a transition year).
 * Company with a 14-month year labelled 2026 and 2028 after it (label 2027 is
 * skipped). Disposable schema fixture only; synthetic data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import report from '../../pages/api/accounting/reports-budget-vs-actual';
import exportCsv from '../../pages/api/accounting/budget-vs-actual-export';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture, type RouteOut } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const rep = budgetsRouteFixture(pool, report, '/api/accounting/reports-budget-vs-actual');
const csv = budgetsRouteFixture(pool, exportCsv, '/api/accounting/budget-vs-actual-export');
let u: SetupUser;
let companyId: string;

/** 'YYYY-MM-01' for each month from `from` ('YYYY-MM') for `count` months. */
const monthsFrom = (from: string, count: number) => Array.from({ length: count }, (_, i) => {
  const ordinal = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1 + i;
  return `${Math.floor(ordinal / 12)}-${String((ordinal % 12) + 1).padStart(2, '0')}-01`;
});

beforeAll(async () => {
  const o = await rep.owner();
  u = o.u;
  companyId = u.homeCompanyId;
  await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [companyId]);
  const years = [[2026, '2026-01-01', '2027-02-28', 'transition'], [2028, '2027-03-01', '2028-02-29', 'normal']] as const;
  for (const [label, start, end, kind] of years) {
    const y = (await pool.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, label, start, end, kind])).rows[0];
    await pool.query('SELECT public.fiscal_periods_generate($1)', [y.id]);
  }
  // 10 a month through the 14-month year, 1 a month through 2028.
  for (const [from, count, amount] of [['2026-01', 14, 10], ['2027-03', 12, 1]] as const) {
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount)
       SELECT $1, $2, m::date, $4 FROM unnest($3::text[]) m`, [companyId, o.account, monthsFrom(from, count), amount]);
  }
});

afterAll(async () => {
  try {
    await rep.cleanup();
    await csv.cleanup();
    await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [companyId]);
  } finally { await pool.end(); }
}, 60000);

type Report = { period: string; lines: Array<{ account_code: string; budget_amount: number }> };
const data = (r: RouteOut) => r.body.data as unknown as { report: Report; fiscal_year: number; years: Array<{ fiscalYear: number }> };

describe('reports-budget-vs-actual?fiscal_year=', () => {
  it('a transition year reports its 14 months', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2026' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(data(r).report.period).toBe('2026-01-01 to 2027-02-28');
    expect(data(r).report.lines.find((l) => l.account_code === 'BR-5000')!.budget_amount).toBe(140);
    expect(data(r).fiscal_year).toBe(2026);
  });

  it('the year after it reports its own 12 months, and the year list is returned for the selector', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2028' });
    expect(data(r).report.period).toBe('2027-03-01 to 2028-02-29');
    expect(data(r).report.lines.find((l) => l.account_code === 'BR-5000')!.budget_amount).toBe(12);
    expect(data(r).years.map((y) => y.fiscalYear)).toEqual(expect.arrayContaining([2026, 2028]));
  });

  it('a label no year carries is a 404', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2027' });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
  });

  it('a value that is not a year label is a 400', async () => {
    for (const bad of ['abc', '2.5', '-1', '0', '20x6']) {
      const r = await rep.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: bad });
      expect(r.status, `${bad} ${JSON.stringify(r.body)}`).toBe(400);
    }
  });

  it('the current month cannot be combined with a year (400)', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'current', fiscal_year: '2026' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  it('year to date of a chosen year runs from its start and never past its end', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'ytd', fiscal_year: '2026' });
    const [start, end] = data(r).report.period.split(' to ');
    expect(start).toBe('2026-01-01');
    expect(end! <= '2027-02-28' && end! >= start!).toBe(true);
  });
});

describe('budget-vs-actual-export?fiscal_year=', () => {
  it('the CSV carries the chosen year\'s budget', async () => {
    const r = await csv.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2026' });
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain('"BR-5000","Rent",140.00,');
    const next = await csv.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2028' });
    expect(String(next.body)).toContain('"BR-5000","Rent",12.00,');
  });

  it('an unknown label is a 404 and a bad one a 400', async () => {
    expect((await csv.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2027' })).status).toBe(404);
    expect((await csv.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: 'abc' })).status).toBe(400);
  });
});
