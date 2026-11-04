/**
 * Budgets P5-6 r2: unassigning a budget holder (DELETE /api/accounting/budgets/holders?id=<holder id>),
 * as real members through withAuth. Owner/admin only, a draft version only; a slice with its reviewer
 * (submitted or approved) keeps its holder (409); the last holder of an open or returned slice takes
 * the slice review with them; another holder keeps it. Audited; another company's holder is 404.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import holdersRoute from '../../pages/api/accounting/budgets/holders';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetHoldersFixture, errCodeOf, type GridWorld } from './helpers/budgetHoldersFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let other: GridWorld;
let holder: SetupUser;
let holder2: SetupUser;
let admin: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  other = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  holder2 = await fx.member(w.u.homeCompanyId, 'manager');
  admin = await fx.member(w.u.homeCompanyId, 'admin');
}, 120_000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120_000);

const holderId = async (versionId: string, userId: string) =>
  String((await pool.query('SELECT id FROM budget_holders WHERE version_id = $1 AND user_id = $2', [versionId, userId])).rows[0]?.id);
const unassign = (u: SetupUser, id: string) => fx.call(holdersRoute, u, 'DELETE', { query: { id } });
const sliceExists = async (id: string) => (await pool.query('SELECT 1 FROM budget_slice_reviews WHERE id = $1', [id])).rows.length === 1;

describe('DELETE /api/accounting/budgets/holders', () => {
  it('the last holder of an open slice: removed, the slice review goes too; audited', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    const r = await unassign(w.u, await holderId(v, holder.userId));
    expect([r.status, r.body.data], JSON.stringify(r.body)).toEqual([200, { removed: true, sliceDeleted: true }]);
    expect(await sliceExists(slice)).toBe(false);
    expect((await fx.audits(v)).some((a) => a.changes.metadata?.holderRemoved === holder.userId)).toBe(true);
  });

  it('another holder remains (or the slice was returned): the slice review stays', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { bu: w.bu });
    await fx.hold(w, v, holder2.userId, { bu: w.bu });
    const r = await unassign(admin, await holderId(v, holder.userId));
    expect([r.status, r.body.data]).toEqual([200, { removed: true, sliceDeleted: false }]);
    expect(await sliceExists(slice)).toBe(true);
    await fx.setStatus(slice, 'submitted', holder2.userId);
    await fx.setStatus(slice, 'returned', w.u.userId, 'redo');
    const last = await unassign(w.u, await holderId(v, holder2.userId));
    expect([last.status, last.body.data]).toEqual([200, { removed: true, sliceDeleted: true }]);
  });

  it('refused: a submitted or approved slice (409, nothing removed), a manager (403), an approved version (409), another company (404)', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc2: w.cc2 });
    const id = await holderId(v, holder.userId);
    await fx.setStatus(slice, 'submitted', holder.userId);
    const sub = await unassign(w.u, id);
    expect([sub.status, errCodeOf(sub)], JSON.stringify(sub.body)).toEqual([409, 'BUDGET_SLICE_STATE']);
    await fx.setStatus(slice, 'approved', w.u.userId);
    expect((await unassign(w.u, id)).status).toBe(409);
    expect(await holderId(v, holder.userId)).toBe(id);
    expect(await sliceExists(slice)).toBe(true);

    const v2 = await fx.version(w);
    await fx.hold(w, v2, holder.userId, { cc1: w.cc1 });
    const id2 = await holderId(v2, holder.userId);
    expect((await unassign(holder, id2)).status).toBe(403);
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [v2, w.u.userId]);
    expect([(await unassign(w.u, id2)).status, errCodeOf(await unassign(w.u, id2))]).toEqual([409, 'BUDGET_SLICE_STATE']);

    const theirs = await fx.version(other);
    const otherHolder = await fx.member(other.u.homeCompanyId, 'manager');
    await fx.hold(other, theirs, otherHolder.userId, { cc1: other.cc1 });
    expect((await unassign(w.u, await holderId(theirs, otherHolder.userId))).status).toBe(404);
    expect((await unassign(w.u, 'not-a-uuid')).status).toBe(400);
  });

  it('the board lists each holder with the id DELETE takes', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    const r = await fx.call(holdersRoute, w.u, 'GET', { query: { versionId: v } });
    const holders = (r.body.data as { slices: Array<{ holders: Array<{ id: string; userId: string }> }> }).slices[0]!.holders;
    expect(holders).toEqual([expect.objectContaining({ id: await holderId(v, holder.userId), userId: holder.userId })]);
  });
});
