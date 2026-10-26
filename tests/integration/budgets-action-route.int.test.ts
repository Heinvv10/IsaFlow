/**
 * The budgets-action route (delete / copy) as the page calls it: input the
 * caller got wrong is a 400 with its own message; a database failure is a 500
 * that does not echo the database's text. Disposable schema fixture only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/budgets-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';

const FAULT_ACCOUNT = '00000000-0000-0000-0000-00000000fa17';
vi.mock('@/modules/accounting/services/core/budgetService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/budgetService')>();
  return {
    ...real,
    deleteBudget: (companyId: string, glAccountId: string, fiscalYear: number) => {
      if (glAccountId === FAULT_ACCOUNT) {
        throw Object.assign(new Error('relation "secret_internal_table" does not exist'), { code: '42P01' });
      }
      return real.deleteBudget(companyId, glAccountId, fiscalYear);
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { call, owner, cleanup } = budgetsRouteFixture(pool, route, '/api/accounting/budgets-action');

afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
}, 60000);

describe('budgets-action', () => {
  it('a budget input error is a 400 carrying its message', async () => {
    const o = await owner();
    const r = await call(o.u, 'POST', { action: 'copy', fromYear: o.label, toYear: o.label });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toBe('Cannot copy a year onto itself');
  });

  it('a glAccountId that is not a UUID is a 400', async () => {
    const o = await owner();
    for (const glAccountId of ['not-a-uuid', '1']) {
      const r = await call(o.u, 'POST', { action: 'delete', glAccountId, fiscalYear: o.label });
      expect(r.status, `${glAccountId} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(400);
    }
  });

  it('a year label that is not a number is a 400', async () => {
    const o = await owner();
    const r = await call(o.u, 'POST', { action: 'delete', glAccountId: o.account, fiscalYear: 'abc' });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(400);
    expect((await call(o.u, 'POST', { action: 'copy', fromYear: 'x', toYear: o.label })).status).toBe(400);
  });

  it('a year label that only Number() would take (true, 1e3, an array) is a 400', async () => {
    const o = await owner();
    for (const bad of [true, '1e3', [o.label], ' 2027', 12345]) {
      const del = await call(o.u, 'POST', { action: 'delete', glAccountId: o.account, fiscalYear: bad });
      expect(del.status, `delete ${JSON.stringify(bad)} ${JSON.stringify(del.body).slice(0, 150)}`).toBe(400);
      const copy = await call(o.u, 'POST', { action: 'copy', fromYear: bad, toYear: o.label + 1 });
      expect(copy.status, `copy ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('a database failure is a 500 that does not echo the database text', async () => {
    const o = await owner();
    // withErrorHandler masks a 500's message in production only.
    vi.stubEnv('NODE_ENV', 'production');
    const r = await call(o.u, 'POST', { action: 'delete', glAccountId: FAULT_ACCOUNT, fiscalYear: o.label }).finally(() => vi.unstubAllEnvs());
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret_internal_table');
  });

  it('deletes an account\'s budget for the year', async () => {
    const o = await owner();
    const months = o.months.map((month) => ({ month, amount: 5 }));
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
       SELECT $1, (SELECT public.budget_version_original($1, fy.fiscal_year, 'test-fixture') FROM public.fiscal_year_for_date($1, (m || '-01')::date) fy), $2, (m || '-01')::date, 5 FROM unnest($3::text[]) m`, [o.u.homeCompanyId, o.account, months.map((m) => m.month)]);
    const r = await call(o.u, 'POST', { action: 'delete', glAccountId: o.account, fiscalYear: o.label });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    const left = await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE company_id = $1', [o.u.homeCompanyId]);
    expect(left.rows[0].n).toBe(0);
  });
});
