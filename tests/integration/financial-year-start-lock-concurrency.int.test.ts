/**
 * The company-row lock of a financial year start change.
 *
 * Every FK insert that points at a company (a journal, a close run, an invoice)
 * takes FOR KEY SHARE on the company row. A FOR UPDATE on that row therefore
 * stalls all of them until the request commits, so a plain settings save (the
 * month unchanged) must not take it. A real change must: it is what stops a
 * close run or journal landing between the reference count and the rebuild.
 * The "in-flight insert" here is a second connection holding FOR KEY SHARE,
 * exactly the lock such an insert holds until it commits.
 *
 * Disposable schema fixture only (assertDisposable). The real withAuth runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { financialYearFixture } from './helpers/financialYearFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = financialYearFixture(pool);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 60000);

/** A second session holding the lock an uncommitted FK insert holds on the company row. */
async function holdKeyShare(companyId: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT id FROM companies WHERE id = $1 FOR KEY SHARE', [companyId]);
  return c;
}

const PENDING = Symbol('pending');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

describe('financial year start: company-row lock', () => {
  it('a save that does not change the month does not wait for an in-flight FK insert', async () => {
    const { u, companyId } = await fx.onboarded();
    const holder = await holdKeyShare(companyId);
    try {
      const save = fx.put(u, { id: companyId, financialYearStart: 3, tradingName: 'No row lock' });
      const first = await within(save, 3000);
      expect(first, 'the save waited on the company row: it took FOR UPDATE for an unchanged month').not.toBe(PENDING);
      expect((first as Awaited<typeof save>).status).toBe(200);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
  });

  it('a same-month save over misaligned periods that are in use does not wait either (no repair, no lock)', async () => {
    const { u, companyId } = await fx.onboarded();
    await fx.makeCalendarPeriods(companyId);
    await fx.journal(companyId, u.userId, 'posted');
    const holder = await holdKeyShare(companyId);
    try {
      const save = fx.put(u, { id: companyId, financialYearStart: 3 });
      const first = await within(save, 3000);
      expect(first, 'the doomed repair took FOR UPDATE').not.toBe(PENDING);
      expect((first as Awaited<typeof save>).status).toBe(200);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await fx.stored(companyId)).toMatchObject({ first_month: 1, periods: 12 });
  });

  it('a real change waits for the in-flight insert, then sees what it wrote and refuses', async () => {
    const { u, companyId } = await fx.onboarded();
    const holder = await holdKeyShare(companyId);
    let change: ReturnType<typeof fx.put> | undefined;
    try {
      change = fx.put(u, { id: companyId, financialYearStart: 6 });
      expect(await within(change, 1500), 'the change did not lock the company row').toBe(PENDING);
      // The in-flight transaction finishes its insert (a close run on a period) and commits.
      await holder.query(
        `INSERT INTO close_runs (company_id, fiscal_period_id, period_label, created_by)
         SELECT $1, id, 'race probe', $2 FROM fiscal_periods WHERE company_id = $1 AND period_number = 1`,
        [companyId, u.userId]);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const out = await change!;
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(await fx.stored(companyId)).toMatchObject({ fy: 3, first_month: 3, periods: 12 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM close_runs WHERE company_id = $1', [companyId])).rows[0].n).toBe(1);
  });
});
