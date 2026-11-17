/**
 * Wave 6 FQx (migration 999p): the per-month unique (company_id, period_year, period_month) is gone, so a regular
 * weekly run and an off-cycle run insert in a month that already holds its monthly regular run. 999a's
 * regular-period key still allows one regular run per (company, frequency, period start).
 *
 * Old colour: the code on this branch outside the migration is the FQb release's createPayrollRun and
 * payrollRunKindGuard, unchanged in behaviour (the removed catch only handled this constraint's 23505). It runs
 * against the new schema here: create still names a second regular run of the month as the duplicate, and the guard
 * still refuses to calculate the weekly and off-cycle runs this schema now admits.
 * Every case runs in its own rolled-back transaction. Disposable fixture DB only.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type RunSpec, type Tenant } from './w6-fqb1.helpers';
import { createPayrollRun, PayrollRunDuplicateError } from '@/modules/accounting/services/payroll/payrollRunHeaders';
import { assertRunKindSupported, RunKindUnsupportedError } from '@/modules/accounting/services/payroll/payrollRunKindGuard';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const MIGRATION = readFileSync('scripts/migrations/sql/999p_payroll_run_headers_drop_month_unique.sql', 'utf8');
const MONTH_KEY = 'payroll_run_headers_company_id_period_year_period_month_key';
let A: Tenant;
let B: Tenant;

const REGULAR: RunSpec = { year: 2026, month: 5, runDate: '2026-05-25', status: 'calculated' };
const BONUS: RunSpec = { year: 2026, month: 5, runDate: '2026-05-28', status: 'calculated', offCycle: true };

async function weekly(c: PoolClient, company: string, start: string, end: string): Promise<string> {
  return String((await c.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, period_start, period_end)
     VALUES ($1, 5, 2026, 'weekly', $2::date, $3::date) RETURNING id`, [company, start, end])).rows[0].id);
}

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** The 23505 constraint name a statement raises, inside a savepoint so the transaction stays usable. */
async function clash(c: PoolClient, run: () => Promise<unknown>): Promise<string | null> {
  await c.query('SAVEPOINT s');
  try {
    await run();
    return null;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code !== '23505') throw err;
    return e.constraint ?? '';
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT s');
  }
}

async function refusedToCalculate(company: string, runId: string): Promise<boolean> {
  try {
    await assertRunKindSupported(company, runId, 'calculate');
    return false;
  } catch (err) {
    if (err instanceof RunKindUnsupportedError) return true;
    throw err;
  }
}

beforeAll(async () => {
  A = await seedTenant(pool, 'W6 FQx A');
  B = await seedTenant(pool, 'W6 FQx B');
});

afterAll(async () => {
  try { await dropTenants(pool, [A, B]); } finally { await pool.end(); }
});

describe('999p schema', () => {
  it('drops the per-month unique and leaves no unique index on (company, year, month); the regular-period key stays', async () => {
    const r = (await pool.query(
      `SELECT (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.payroll_run_headers'::regclass AND conname = $1) AS month_key,
              (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = 'public.payroll_run_headers'::regclass AND i.indisunique
                 AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                       WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)) = ARRAY['company_id', 'period_month', 'period_year']) AS month_index,
              to_regclass('public.payroll_run_headers_regular_period_key') IS NOT NULL AS regular_key`, [MONTH_KEY])).rows[0];
    expect(r).toEqual({ month_key: 0, month_index: 0, regular_key: true });
  });

  it('a regular weekly run and an off-cycle run insert in the month that holds its monthly regular run', async () => {
    const got = await inTx(async (c) => {
      await seedRun(c, A, REGULAR);
      await seedRun(c, A, BONUS);
      await weekly(c, A.company, '2026-05-04', '2026-05-10');
      await weekly(c, A.company, '2026-05-11', '2026-05-17');
      await seedRun(c, B, REGULAR);
      return (await c.query(
        `SELECT company_id::text AS company, string_agg(pay_frequency || '/' || run_kind, ',' ORDER BY pay_frequency, run_kind, period_start) AS runs
           FROM payroll_run_headers WHERE company_id = ANY($1) AND period_year = 2026 AND period_month = 5
          GROUP BY company_id`, [[A.company, B.company]])).rows;
    });
    expect(Object.fromEntries(got.map((r) => [r.company, r.runs]))).toEqual({
      [A.company]: 'monthly/off_cycle,monthly/regular,weekly/regular,weekly/regular',
      [B.company]: 'monthly/regular',
    });
  });

  it('one regular run per (company, frequency, period start) still holds: a second monthly or a second same-week run is 23505', async () => {
    const got = await inTx(async (c) => {
      await seedRun(c, A, REGULAR);
      await weekly(c, A.company, '2026-05-04', '2026-05-10');
      return {
        monthly: await clash(c, () => seedRun(c, A, REGULAR)),
        week: await clash(c, () => weekly(c, A.company, '2026-05-04', '2026-05-10')),
        bonus: await clash(c, () => seedRun(c, A, BONUS)),
      };
    });
    expect(got).toEqual({ monthly: 'payroll_run_headers_regular_period_key', week: 'payroll_run_headers_regular_period_key', bonus: null });
  });

  it('re-applying the migration is a no-op', async () => {
    const left = await inTx(async (c) => {
      await c.query(MIGRATION);
      return (await c.query('SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1', [MONTH_KEY])).rows[0].n;
    });
    expect(left).toBe(0);
  });
});

describe('old colour (the FQb release) against the 999p schema', () => {
  it('create: the monthly run is created beside an off-cycle and a weekly run, and a second one is the named duplicate', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, BONUS);
      await weekly(c, A.company, '2026-05-04', '2026-05-10');
    }, async () => {
      const run = await createPayrollRun(A.company, { month: 5, year: 2026 }, A.user);
      const again = await createPayrollRun(A.company, { month: 5, year: 2026 }, A.user).then(() => null, (e: unknown) => e);
      return { run, again };
    });
    expect(got.run).toMatchObject({ periodMonth: 5, periodYear: 2026, runKind: 'regular', payFrequency: 'monthly' });
    expect(got.again).toBeInstanceOf(PayrollRunDuplicateError);
  });

  it('calculate: the guard refuses the weekly and the off-cycle run the schema now admits, and passes the monthly one', async () => {
    const ids: Record<string, string> = {};
    const got = await twoRunsInMonth(pool, A, async (c) => {
      ids.monthly = await seedRun(c, A, REGULAR);
      ids.bonus = await seedRun(c, A, BONUS);
      ids.weekly = await weekly(c, A.company, '2026-05-04', '2026-05-10');
    }, async () => ({
      monthly: await refusedToCalculate(A.company, ids.monthly!),
      bonus: await refusedToCalculate(A.company, ids.bonus!),
      weekly: await refusedToCalculate(A.company, ids.weekly!),
    }));
    expect(got).toEqual({ monthly: false, bonus: true, weekly: true });
  });
});
