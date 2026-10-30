/**
 * Budgets P4: writers of one version serialise on its row (`takeVersion`, the compare-and-set the
 * grid save and the driver writes share). A driver PUT and a grid save sent with ONE token, held
 * at the version row and released together, end in one 200 and one 409 STALE, never a deadlock;
 * four different driver writes with one token make at most one change and no 5xx. Two connections
 * (more through withAuth), real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { errCode } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;

beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

describe('concurrent writes of one version', () => {
  it('a driver PUT and a grid save with one token, released together: one 200, one 409 STALE, no deadlock (PROBE 5)', async () => {
    const { v } = await fx.cogsOfSales(w);
    const token = await fx.token(v);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM budget_versions WHERE id = $1 FOR UPDATE', [v]);
      const put = fx.call.drivers(w.u, 'PUT', {
        versionId: v, expectedUpdatedAt: token, glAccountId: w.rent, kind: 'fixed', amount: 10, fromMonth: w.months[0], toMonth: w.months[11],
      });
      const save = fx.call.save(w.u, v, [{ glAccountId: w.sales, cc1Id: null, cc2Id: null, buId: null, month: w.months[1], amount: 2000 }]);
      // Both are queued behind the holder's row lock before it lets go.
      await new Promise((res) => setTimeout(res, 400));
      await holder.query('COMMIT');
      const out = await Promise.all([put, save]);
      expect(out.map((r) => r.status).sort(), out.map(dump).join(' | ')).toEqual([200, 409]);
      expect(errCode(out.find((r) => r.status === 409)!)).toBe('BUDGET_VERSION_STALE');
    } finally {
      holder.release();
    }
    // Whichever won wrote one audit row on top of the driver PUT's.
    expect((await fx.audits(v)).length).toBe(2);
  });

  it('four different driver writes with one token: at most one 200, the rest 409, no 5xx (PROBE 6)', async () => {
    const { v } = await fx.cogsOfSales(w);
    const token = await fx.token(v);
    const writes = await Promise.all([
      fx.call.drivers(w.u, 'PUT', { versionId: v, expectedUpdatedAt: token, glAccountId: w.rent, kind: 'fixed', amount: 10, fromMonth: w.months[0], toMonth: w.months[11] }),
      fx.call.hires(w.u, 'POST', { versionId: v, expectedUpdatedAt: token, label: 'Clerk', startMonth: w.months[2] }),
      fx.call.override(w.u, { versionId: v, expectedUpdatedAt: token, glAccountId: w.cogs }),
      fx.call.headcount(w.u, 'POST', { versionId: v, expectedUpdatedAt: token }),
    ]);
    expect(writes.filter((r) => r.status >= 500).map(dump)).toEqual([]);
    expect(writes.filter((r) => r.status === 200).length, writes.map(dump).join(' | ')).toBeLessThanOrEqual(1);
    for (const r of writes.filter((x) => x.status !== 200)) expect([r.status, errCode(r)], dump(r)).toEqual([409, 'BUDGET_VERSION_STALE']);
  });
});
