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
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const made: string[] = [];
const users: string[] = [];

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM budget_month_amounts WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM accounting_budgets WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
    }
    for (const u of users) await pool.query('DELETE FROM company_users WHERE user_id = $1', [u]);
  } finally { await pool.end(); }
}, 60000);

type Out = { status: number; body: { data?: Record<string, unknown>; error?: { message?: string } } };

async function call(u: SetupUser, method: string, body?: unknown, query: Record<string, string> = {}): Promise<Out> {
  const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, method) as unknown as
    { url: string; query: Record<string, string>; body: unknown };
  req.url = '/api/accounting/budgets';
  req.query = query;
  req.body = body;
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as Out['body'] };
}

/** An owner of a fresh March company with an expense account; its current year generated. */
async function owner(): Promise<{ u: SetupUser; account: string; label: number; months: string[] }> {
  const u = await newSetupUser(pool);
  users.push(u.userId);
  made.push(u.homeCompanyId);
  await pool.query('UPDATE companies SET financial_year_start = 3 WHERE id = $1', [u.homeCompanyId]);
  // Two statements: a row the function inserts is not visible to the statement that called it.
  const yearId = (await pool.query('SELECT public.fiscal_year_ensure($1, CURRENT_DATE) AS id', [u.homeCompanyId])).rows[0].id;
  const year = (await pool.query('SELECT fiscal_year, start_date::text s FROM fiscal_years WHERE id = $1', [yearId])).rows[0];
  const account = (await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, 'BR-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [u.homeCompanyId])).rows[0].id;
  const start = new Date(`${year.s}T00:00:00Z`);
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  return { u, account, label: Number(year.fiscal_year), months };
}

describe('GET', () => {
  it('the first load (no year, or an empty one) answers the current year, its budgets and the year list', async () => {
    const o = await owner();
    for (const query of [{}, { fiscal_year: '' }]) {
      const r = await call(o.u, 'GET', undefined, query);
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      expect(r.body.data?.fiscalYear).toBe(o.label);
      expect(r.body.data?.monthKeys).toEqual(o.months);
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
});
