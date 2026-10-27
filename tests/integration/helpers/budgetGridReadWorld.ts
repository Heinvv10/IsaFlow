/**
 * Shared by the budget-grid read suites (budget-grid-read*.int.test.ts): the pool, the fixture,
 * the route caller and the service-on-a-superuser-connection caller, plus one world of companies
 * built in a beforeAll and dropped in an afterAll (both registered by `budgetGridReadWorld()`).
 *
 * Company A: an approved primary FY2027 'Original' with amounts on every kind of account (a CC1
 * split, a legacy header budget, an inactive account, other income, a bank account that is never
 * listed, a month outside the year), a draft scenario and a locked reforecast of FY2027, and two
 * FY2028 versions with no primary. Company B: its own FY2027 primary (R3 of sales) and scenario.
 * Company T: a 14-month transition year. All data synthetic.
 */
import { afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import gridRoute from '../../../pages/api/accounting/budget-grid/index';
import { als } from '@/lib/als';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { budgetGridFixture, monthsFrom, type GridCo } from './budgetGridFixture';

export const FY27 = monthsFrom('2026-03');
const URL = '/api/accounting/budget-grid';

export interface ReadWorld {
  A: GridCo; B: GridCo; T: GridCo;
  primary: string; draftScenario: string; lockedFy27: string; newestFy28: string;
}

export const data = <T,>(r: { body: { data?: unknown } }) => r.body.data as T;

export function budgetGridReadWorld() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const fx = budgetGridFixture(pool);
  const get = (c: GridCo, query: Record<string, string>, who: 'owner' | 'viewer' = 'owner') => fx.call(gridRoute, URL, c[who], 'GET', query);
  /** Filled by the beforeAll below; read it inside tests and hooks, never at import time. */
  const w = {} as ReadWorld;

  beforeAll(async () => {
    const A = await fx.company();
    const B = await fx.company();
    const T = await fx.company({ transition: true });
    const a = A.acct;

    const primary = await fx.version(A, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
    await fx.amounts(A, primary, a.sales, FY27, 1000);
    await fx.amounts(A, primary, a.cos, FY27, 400);
    await fx.amounts(A, primary, a.rent, FY27, 100, { cc1: A.cc1 });
    await fx.amounts(A, primary, a.rent, FY27, 50, { cc1: A.cc1b });
    await fx.amounts(A, primary, a.childA, FY27, 30);
    await fx.amounts(A, primary, a.childB, FY27, 20);
    await fx.amount(A, primary, a.header, '2026-03', 7); // a legacy header budget
    await fx.amount(A, primary, a.inactive, '2026-03', 11); // inactive, but it holds an amount
    await fx.amount(A, primary, a.otherIncome, '2026-03', 40);
    await fx.amount(A, primary, a.bank, '2026-03', 999); // not revenue/expense: never listed
    await fx.amount(A, primary, a.sales, '2030-01', 5555); // outside the year's months: ignored
    const draftScenario = await fx.version(A, { fy: 2027, name: 'Scenario', kind: 'scenario' });
    const lockedFy27 = await fx.version(A, { fy: 2027, name: 'Locked copy', kind: 'reforecast', status: 'locked' });
    await fx.version(A, { fy: 2028, name: 'Older', kind: 'original' });
    const newestFy28 = await fx.version(A, { fy: 2028, name: 'Newest', kind: 'scenario' });

    // Company B: the same fiscal years, its own versions and amounts.
    const bp = await fx.version(B, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
    await fx.amount(B, bp, B.acct.sales, '2026-03', 3);
    await fx.version(B, { fy: 2027, name: 'B scenario', kind: 'scenario' });
    Object.assign(w, { A, B, T, primary, draftScenario, lockedFy27, newestFy28 });
  }, 120000);

  afterAll(async () => {
    try {
      await fx.cleanup();
    } finally {
      await pool.end();
    }
  }, 60000);

  /** The service on a superuser connection (no RLS), so only the query's own company_id isolates tenants. */
  async function direct(c: GridCo, opts: { versionId?: string; fiscalYear?: number }): Promise<GridReadModel> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await als.run({ client, companyId: c.id, userId: c.user, claims: {} } as never, () => loadGridReadModel(c.id, opts));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  return { pool, fx, get, direct, w };
}
