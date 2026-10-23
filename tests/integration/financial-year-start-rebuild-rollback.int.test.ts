/**
 * A rebuild that fails AFTER companyService.updateCompany has written the row
 * must roll the whole request back.
 *
 * withAuth commits any answer below 500. The pre-check
 * (assertFinancialYearStartChange) refuses with a 409 before anything is
 * written; the rebuild after the UPDATE re-counts the references under the row
 * lock, so its refusal is not reachable through the real flow. If it ever were,
 * a 409 would commit financial_year_start = new while the periods stayed on
 * the old month: exactly the drift the lock exists to prevent. So a failure
 * there is a 500 and the request is rolled back. This suite forces the
 * rebuild's refusal to prove it.
 *
 * Disposable schema fixture only (assertDisposable). The real withAuth runs.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { financialYearFixture } from './helpers/financialYearFixture';

const force = vi.hoisted(() => ({ refuse: false }));
/** The real rebuild (onboarding uses it too), refusing only while `force.refuse` is set. */
vi.mock('@/modules/accounting/services/gl/fiscalYearStartChange', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/gl/fiscalYearStartChange')>();
  return {
    ...real,
    rebuildUnusedFiscalPeriods: async (...a: Parameters<typeof real.rebuildUnusedFiscalPeriods>) => {
      if (force.refuse) throw new real.FiscalPeriodsInUseError({ ...real.NO_REFERENCES, journals: 1 });
      return real.rebuildUnusedFiscalPeriods(...a);
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = financialYearFixture(pool);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 60000);

describe('updateCompany: a rebuild refusal after the UPDATE', () => {
  it('answers 500 and leaves the company row and its periods as they were', async () => {
    const { u, companyId } = await fx.onboarded();
    const before = await fx.stored(companyId);
    force.refuse = true;
    const out = await fx.put(u, { id: companyId, financialYearStart: 6, tradingName: 'must roll back' });
    expect(out.status, JSON.stringify(out.body)).toBe(500);
    expect(await fx.stored(companyId)).toEqual(before);
  });
});
