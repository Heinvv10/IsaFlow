/**
 * The budgets route, read-only since the budget workspace replaced the old page (real withAuth,
 * request transaction): the GET reads the budgets and the year list on the ONE request connection
 * (savepoints there must nest, never interleave), the first load (no year chosen yet) is answered
 * with the current year, `years_only=1` answers the year list WITHOUT reading the budgets (what
 * the workspace's year select uses), and a write method is a 405. Disposable schema fixture only;
 * synthetic data.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/budgets';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';

const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/modules/accounting/services/core/budgetService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/budgetService')>();
  return { ...real, getBudgetsForYear: (...a: Parameters<typeof real.getBudgetsForYear>) => { reads.n += 1; return real.getBudgetsForYear(...a); } };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { call, owner, cleanup, seedPrimary } = budgetsRouteFixture(pool, route, '/api/accounting/budgets');

beforeEach(() => { reads.n = 0; });
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
}, 60000);

describe('GET', () => {
  it('the first load (no year, or an empty one) answers the current year, its budgets and the year list', async () => {
    const o = await owner();
    for (const query of [{}, { fiscal_year: '' }]) {
      const r = await call(o.u, 'GET', undefined, query);
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      expect(r.body.data?.fiscalYear).toBe(o.label);
      expect((r.body.data?.year as { monthKeys: string[] }).monthKeys).toEqual(o.months);
      expect(r.body.data).not.toHaveProperty('monthKeys');
      expect(r.body.data?.items).toEqual([]);
      expect((r.body.data?.years as Array<{ fiscalYear: number }>).map((y) => y.fiscalYear)).toContain(o.label);
    }
    expect(reads.n).toBe(2);
  });

  it('a chosen year with a saved budget reads back every month, on one request connection', async () => {
    const o = await owner();
    const months = o.months.map((month, i) => ({ month, amount: (i + 1) * 10 }));
    await seedPrimary(o.u, o.account, o.label, months);
    const r = await call(o.u, 'GET', undefined, { fiscal_year: String(o.label) });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const items = r.body.data?.items as Array<{ annualAmount: number; months: Array<{ month: string; amount: number }> }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.annualAmount).toBe(780);
    expect(items[0]!.months).toEqual(months);
  });

  it('a year label that is not a number is a 400', async () => {
    const o = await owner();
    for (const bad of ['abc', '1e3', '2.5', ' 2027', '12345']) {
      expect((await call(o.u, 'GET', undefined, { fiscal_year: bad })).status, bad).toBe(400);
    }
  });
});

describe('GET years_only=1 (the workspace year select)', () => {
  it('answers the current year and the year list, and never reads the budgets', async () => {
    const o = await owner();
    await seedPrimary(o.u, o.account, o.label, o.months.map((month) => ({ month, amount: 100 })));
    reads.n = 0;
    const r = await call(o.u, 'GET', undefined, { years_only: '1' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.data?.fiscalYear).toBe(o.label);
    expect((r.body.data?.year as { monthKeys: string[] }).monthKeys).toEqual(o.months);
    expect((r.body.data?.years as Array<{ fiscalYear: number }>).map((y) => y.fiscalYear)).toContain(o.label);
    expect(r.body.data).not.toHaveProperty('items');
    expect(reads.n).toBe(0);
  });

  it('a chosen year works the same way; a years_only that is not 1 is a 400', async () => {
    const o = await owner();
    const r = await call(o.u, 'GET', undefined, { years_only: '1', fiscal_year: String(o.label) });
    expect([r.status, r.body.data?.fiscalYear, reads.n]).toEqual([200, o.label, 0]);
    for (const bad of ['0', 'true', 'yes', '']) {
      expect((await call(o.u, 'GET', undefined, { years_only: bad })).status, bad).toBe(400);
    }
    expect(reads.n).toBe(0);
  });
});

describe('writes are retired (the workspace saves through budget-grid/save)', () => {
  it('POST, PUT and DELETE are 405 and write nothing', async () => {
    const o = await owner();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await call(o.u, method, { glAccountId: o.account, fiscalYear: o.label, annualAmount: 100 });
      expect(r.status, `${method} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(405);
    }
    const n = (await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE company_id = $1', [o.u.homeCompanyId])).rows[0].n;
    expect(n).toBe(0);
  });
});
