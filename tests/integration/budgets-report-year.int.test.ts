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
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
       SELECT $1, (SELECT public.budget_version_original($1, fy.fiscal_year, 'test-fixture') FROM public.fiscal_year_for_date($1, m::date) fy), $2, m::date, $4 FROM unnest($3::text[]) m`, [companyId, o.account, monthsFrom(from, count), amount]);
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
    for (const bad of ['abc', '2.5', '-1', '0', '20x6', '1e3', ' 2026', '12345']) {
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

describe('year to date of a year that has not started', () => {
  // Label 2060 is the registry's template year Mar 2059 - Feb 2060: it never starts within a test's lifetime.
  it('is empty: no lines, zero totals, and the report says when the year starts', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'ytd', fiscal_year: '2060' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const d = r.body.data as unknown as { report: Report & { total_budget: number; total_actual: number; not_started?: boolean; starts_on?: string } };
    expect(d.report.lines).toEqual([]);
    expect([d.report.total_budget, d.report.total_actual]).toEqual([0, 0]);
    expect(d.report.not_started).toBe(true);
    expect(d.report.starts_on).toBe('2059-03-01');
  });

  it('is empty whatever day the year starts on: a year starting 15 March shows none of its March budget', async () => {
    // FY2100 = 15 March 2099 - 14 March 2100, with a budget in each of its 13 months (a window ending the
    // day before its start would still name March 2099 and count its whole month).
    await pool.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2100, '2099-03-15', '2100-03-14')`, [companyId]);
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
       SELECT $1, public.budget_version_original($1, 2100, 'test-fixture'), (SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = 'BR-5000'), m::date, 5
         FROM unnest($2::text[]) m`, [companyId, monthsFrom('2099-03', 13)]);
    const r = await rep.call(u, 'GET', undefined, { period: 'ytd', fiscal_year: '2100' });
    const d = r.body.data as unknown as { report: Report & { total_budget: number; not_started?: boolean } };
    expect(d.report.not_started).toBe(true);
    expect(d.report.lines).toEqual([]);
    expect(d.report.total_budget).toBe(0);
    const c = await csv.call(u, 'GET', undefined, { period: 'ytd', fiscal_year: '2100' });
    expect(String(c.body).split('\n').every((l, i) => i === 0 || l.endsWith(',0.00,0.00,0.00,0.00'))).toBe(true);
    // The same year's full year does count its budget.
    const full = await rep.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2100' });
    expect((full.body.data as unknown as { report: Report }).report.lines.find((l) => l.account_code === 'BR-5000')!.budget_amount).toBe(65);
  });

  it('the full year of it is a normal report', async () => {
    const r = await rep.call(u, 'GET', undefined, { period: 'full_year', fiscal_year: '2060' });
    expect(r.status).toBe(200);
    expect((r.body.data as unknown as { report: { not_started?: boolean } }).report.not_started).toBeUndefined();
  });

  it('the CSV of it is all zeros, the budget of the other years not among them', async () => {
    const r = await csv.call(u, 'GET', undefined, { period: 'ytd', fiscal_year: '2060' });
    const [header, ...rows] = String(r.body).split('\n');
    expect(header).toBe('Account Code,Account Name,Budget,Actual,Variance,Variance %');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => l.endsWith(',0.00,0.00,0.00,0.00'))).toBe(true);
    expect(rows.at(-1)).toBe('"","TOTALS",0.00,0.00,0.00,0.00');
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
