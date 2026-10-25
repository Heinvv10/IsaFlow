/**
 * A failure in the Budget vs Actual report or its CSV export that is not the
 * caller's mistake is a 500 (withErrorHandler, message masked in production),
 * never a 400 or a database-error body that echoes the failure. Disposable
 * schema fixture only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const fault = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/accounting/services/reports/budgetWindowService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/reports/budgetWindowService')>();
  return {
    ...real,
    loadWindowBudgets: (...args: Parameters<typeof real.loadWindowBudgets>) => {
      if (fault.on) throw Object.assign(new Error('relation "secret_internal_table" does not exist'), { code: '42P01' });
      return real.loadWindowBudgets(...args);
    },
  };
});

import report from '../../pages/api/accounting/reports-budget-vs-actual';
import exportCsv from '../../pages/api/accounting/budget-vs-actual-export';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const rep = budgetsRouteFixture(pool, report, '/api/accounting/reports-budget-vs-actual');
const csv = budgetsRouteFixture(pool, exportCsv, '/api/accounting/budget-vs-actual-export');

afterAll(async () => {
  try { await rep.cleanup(); await csv.cleanup(); } finally { await pool.end(); }
}, 60000);

describe('report and export failures', () => {
  it.each([['report', rep], ['export', csv]] as const)('a database failure in the %s is a 500 that does not echo it', async (_name, fx) => {
    const o = await fx.owner();
    expect((await fx.call(o.u, 'GET', undefined, { period: 'ytd' })).status).toBe(200);
    fault.on = true;
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const r = await fx.call(o.u, 'GET', undefined, { period: 'ytd' });
      expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain('secret_internal_table');
      // withErrorHandler's answer, not a route-made database-error body.
      expect((r.body as { code?: string }).code).toBe('INTERNAL_SERVER_ERROR');
    } finally {
      fault.on = false;
      vi.unstubAllEnvs();
    }
  });
});
