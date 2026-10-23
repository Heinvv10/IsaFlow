/**
 * The budgets route as the budgets page calls it (real withAuth, request
 * transaction, CSRF): the GET reads the budgets and the year list on the ONE
 * request connection (savepoints there must nest, never interleave), the page's
 * first load (no year chosen yet) is answered with the current year, and bad
 * POST bodies are 400s, not 500s. Disposable schema fixture only; synthetic data.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/budgets';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { call, owner, cleanup } = budgetsRouteFixture(pool, route, '/api/accounting/budgets');

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
      expect((r.body.data?.years as Array<{ fiscalYear: number }>).map((y) => y.fiscalYear)).toContain(o.label);
    }
  });

  it('a chosen year with a saved budget reads back every month, on one request connection', async () => {
    const o = await owner();
    const months = o.months.map((month, i) => ({ month, amount: (i + 1) * 10 }));
    const saved = await call(o.u, 'POST', { glAccountId: o.account, fiscalYear: o.label, months });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
    const r = await call(o.u, 'GET', undefined, { fiscal_year: String(o.label) });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const items = r.body.data?.items as Array<{ annualAmount: number; months: Array<{ month: string; amount: number }> }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.annualAmount).toBe(780);
    expect(items[0]!.months).toEqual(months);
  });

  it('a year label that is not a number is a 400', async () => {
    const o = await owner();
    expect((await call(o.u, 'GET', undefined, { fiscal_year: 'abc' })).status).toBe(400);
  });
});

describe('POST bodies that are wrong are 400s', () => {
  it('a fiscalYear that is not a year label', async () => {
    const o = await owner();
    const r = await call(o.u, 'POST', { glAccountId: o.account, fiscalYear: 'abc', annualAmount: 100 });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
  });

  it('a months entry that is null or has no month', async () => {
    const o = await owner();
    for (const bad of [null, { amount: 5 }, { month: 202601, amount: 5 }]) {
      const months = [bad, ...o.months.slice(1).map((month) => ({ month, amount: 1 }))];
      const r = await call(o.u, 'POST', { glAccountId: o.account, fiscalYear: o.label, months });
      expect(r.status, `${JSON.stringify(bad)} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(400);
    }
  });

  it('a glAccountId that is not a UUID', async () => {
    const o = await owner();
    for (const glAccountId of ['not-a-uuid', '1', '00000000-0000-0000-0000-00000000000g']) {
      const r = await call(o.u, 'POST', { glAccountId, fiscalYear: o.label, annualAmount: 100 });
      expect(r.status, `${glAccountId} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(400);
    }
  });
});
