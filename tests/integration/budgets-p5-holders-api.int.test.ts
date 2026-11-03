/**
 * Budgets P5-6 through the routes (spec §3f, §4, §6 T11; decision 9a), called as real members
 * through withAuth (app_user, claims, request transaction, CSRF):
 * - POST/GET /api/accounting/budgets/holders: owner/admin assign a manager+ to a slice of a draft;
 *   a viewer cannot be assigned; a manager cannot assign; members see their own slices only.
 * - the grid save refuses a holder's cell outside their slices (403) and any write into a submitted
 *   slice by anyone but the reviewer (409), writing nothing; the grid read shows a holder their slices.
 * - POST /api/accounting/budgets/slices/<id>/{submit,approve,return}: who, notes, notifications, audit.
 * - version approve refused while a slice is not approved; the owner forces it with a reason (audited).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import holdersRoute from '../../pages/api/accounting/budgets/holders';
import sliceRoute from '../../pages/api/accounting/budgets/slices/[id]/[action]';
import statusRoute from '../../pages/api/accounting/budget-versions/[id]/status';
import versionRoute from '../../pages/api/accounting/budget-versions/[id]/index';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetHoldersFixture, errCodeOf, type GridWorld } from './helpers/budgetHoldersFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let other: GridWorld;
let holder: SetupUser;
let manager: SetupUser;
let viewer: SetupUser;
let admin: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  other = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  manager = await fx.member(w.u.homeCompanyId, 'manager');
  viewer = await fx.member(w.u.homeCompanyId, 'viewer');
  admin = await fx.member(w.u.homeCompanyId, 'admin');
}, 120_000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120_000);

const dump = (r: { status: number; body: unknown }) => JSON.stringify(r.body).slice(0, 400);
const assign = (u: SetupUser, body: Record<string, unknown>) => fx.call(holdersRoute, u, 'POST', { body });
const move = (u: SetupUser, id: string, action: string, body: Record<string, unknown> = {}) =>
  fx.call(sliceRoute, u, 'POST', { query: { id, action }, body });
const cell = (glAccountId: string, month: string, amount: number, dims: { cc1Id?: string; cc2Id?: string; buId?: string } = {}) =>
  ({ glAccountId, cc1Id: dims.cc1Id ?? null, cc2Id: dims.cc2Id ?? null, buId: dims.buId ?? null, month, amount });
const save = async (u: SetupUser, v: string, cells: unknown[]) =>
  fx.call(saveRoute, u, 'POST', { body: { versionId: v, expectedUpdatedAt: await fx.token(v), cells } });
const approveVersion = async (u: SetupUser, v: string, extra: Record<string, unknown> = {}) =>
  fx.call(statusRoute, u, 'POST', { query: { id: v }, body: { action: 'approve', ...extra } });

describe('POST/GET /api/accounting/budgets/holders', () => {
  it('an owner assigns a manager to a CC1 slice of a draft, with a due date: the slice is open; the holder is told', async () => {
    const v = await fx.version(w);
    const r = await assign(w.u, { versionId: v, userId: holder.userId, cc1Id: w.cc1, dueDate: '2030-06-30' });
    expect(r.status, dump(r)).toBe(200);
    expect(r.body.data).toMatchObject({ versionId: v, cc1Id: w.cc1, status: 'open', dueDate: '2030-06-30', label: 'CC1 GS-C1 GS-C1' });
    expect((r.body.data as { holders: Array<{ userId: string }> }).holders.map((h) => h.userId)).toEqual([holder.userId]);
    expect((await fx.notes(w.u.homeCompanyId, holder.userId)).some((n) => n.title.startsWith('You hold a budget slice'))).toBe(true);
    // Assigning again keeps the status and moves the due date.
    const again = await assign(admin, { versionId: v, userId: holder.userId, cc1Id: w.cc1, dueDate: '2030-07-31' });
    expect([again.status, (again.body.data as { dueDate: string }).dueDate]).toEqual([200, '2030-07-31']);
  });

  it('refuses: a viewer as holder (400), a manager assigning (403), an approved version (409), another company\'s version (404), two dimensions (400) or a bad date (422, zod)', async () => {
    const v = await fx.version(w);
    const r1 = await assign(w.u, { versionId: v, userId: viewer.userId, cc1Id: w.cc1 });
    expect([r1.status, String(r1.body.error?.message)]).toEqual([400, expect.stringContaining('manager, admin or owner')]);
    expect((await assign(manager, { versionId: v, userId: holder.userId, cc1Id: w.cc1 })).status).toBe(403);
    const approved = await fx.version(w, { status: 'approved' });
    const r3 = await assign(w.u, { versionId: approved, userId: holder.userId, cc1Id: w.cc1 });
    expect([r3.status, errCodeOf(r3)]).toEqual([409, 'BUDGET_SLICE_STATE']);
    const theirs = await fx.version(other);
    expect((await assign(w.u, { versionId: theirs, userId: holder.userId })).status).toBe(404);
    expect((await assign(w.u, { versionId: v, userId: holder.userId, cc1Id: w.cc1, buId: w.bu })).status).toBe(400);
    expect((await assign(w.u, { versionId: v, userId: holder.userId, dueDate: '2030-02-31' })).status).toBe(422);
    expect((await pool.query('SELECT COUNT(*)::int n FROM budget_holders WHERE version_id = $1', [v])).rows[0].n).toBe(0);
  });

  it('GET: an owner sees every slice; a holder only theirs; a viewer none', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    await fx.hold(w, v, manager.userId, { bu: w.bu });
    const list = async (u: SetupUser) => ((await fx.call(holdersRoute, u, 'GET', { query: { versionId: v } })).body.data as { slices: Array<{ label: string }> }).slices.map((s) => s.label).sort();
    expect(await list(w.u)).toEqual(['BU GS-BU Ops', 'CC1 GS-C1 GS-C1']);
    expect(await list(holder)).toEqual(['CC1 GS-C1 GS-C1']);
    expect(await list(viewer)).toEqual([]);
  });
});

describe('the slice workflow through the routes', () => {
  it('holder edits only inside their slice; submit locks it; reviewers return (note) and approve; owner edits on the reviewer path', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    const [m0, m1] = w.months;
    // Outside the slice: 403, nothing written.
    const out = await save(holder, v, [cell(w.rent, m0!, 10, { cc1Id: w.cc1 }), cell(w.sales, m0!, 5, { cc2Id: w.cc2 })]);
    expect([out.status, errCodeOf(out)], dump(out)).toEqual([403, 'BUDGET_SLICE_FORBIDDEN']);
    // The service's own check (it names the cell), before the database's backstop is reached.
    expect(String(out.body.error?.message)).toBe(`You can change only your own budget slices: account GS-4000 Sales month ${m0} is outside them`);
    expect(await fx.cells(v)).toEqual([]);
    const ok = await save(holder, v, [cell(w.rent, m0!, 10, { cc1Id: w.cc1 })]);
    expect(ok.status, dump(ok)).toBe(200);

    const sub = await move(holder, slice, 'submit');
    expect([sub.status, (sub.body.data as { status: string }).status], dump(sub)).toEqual([200, 'submitted']);
    for (const u of [w.u, admin]) expect((await fx.notes(w.u.homeCompanyId, u.userId)).some((n) => n.kind === 'budget_slice' && n.title.includes('submitted'))).toBe(true);
    const locked = await save(holder, v, [cell(w.rent, m1!, 11, { cc1Id: w.cc1 })]);
    expect([locked.status, errCodeOf(locked)]).toEqual([409, 'BUDGET_SLICE_LOCKED']);
    expect(String(locked.body.error?.message)).toContain(`is submitted for review (account BR-5000 Rent month ${m1})`);
    const byManager = await save(manager, v, [cell(w.rent, m1!, 11, { cc1Id: w.cc1 })]);
    expect([byManager.status, errCodeOf(byManager)]).toEqual([409, 'BUDGET_SLICE_LOCKED']);

    expect((await move(manager, slice, 'approve')).status).toBe(403);
    expect((await move(holder, slice, 'approve')).status).toBe(403);
    expect((await move(w.u, slice, 'return')).status).toBe(400);
    // The reviewer path: an owner changes the submitted slice.
    const review = await save(w.u, v, [cell(w.rent, m1!, 12, { cc1Id: w.cc1 })]);
    expect(review.status, dump(review)).toBe(200);
    const ret = await move(w.u, slice, 'return', { note: 'Trim June' });
    expect([ret.status, (ret.body.data as { status: string; decisionNote: string }).decisionNote]).toEqual([200, 'Trim June']);
    expect((await fx.notes(w.u.homeCompanyId, holder.userId)).some((n) => n.title.startsWith('Budget slice returned'))).toBe(true);
    expect((await save(holder, v, [cell(w.rent, m1!, 9, { cc1Id: w.cc1 })])).status).toBe(200);
    expect((await move(holder, slice, 'submit')).status).toBe(200);
    const appr = await move(admin, slice, 'approve', { note: 'Fine' });
    expect([appr.status, (appr.body.data as { status: string; decidedBy: string }).decidedBy]).toEqual([200, admin.userId]);
    expect((await move(holder, slice, 'submit')).status).toBe(409);
    const audits = (await fx.audits(v)).map((a) => a.changes.metadata?.sliceAction).filter(Boolean);
    expect(audits).toEqual(['submit', 'return', 'submit', 'approve']);
  });

  it('the grid read shows a holder their slices only (cells, roll-ups, `holder`); the owner sees everything', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    await fx.amount(w, v, w.rent, w.months[0]!, 10, { cc1: w.cc1 });
    await fx.amount(w, v, w.sales, w.months[0]!, 99, { cc2: w.cc2 });
    const read = async (u: SetupUser) => (await fx.call(gridRoute, u, 'GET', { query: { version_id: v } })).body.data as
      { cells: Array<{ glAccountId: string }>; holder: { slices: Array<{ cc1Id: string }> } | null; totals: unknown };
    const mine = await read(holder);
    expect(mine.cells.map((c) => c.glAccountId)).toEqual([w.rent]);
    expect(mine.holder?.slices.map((s) => s.cc1Id)).toEqual([w.cc1]);
    expect(JSON.stringify(mine.totals)).not.toContain('99');
    const all = await read(w.u);
    expect(all.cells).toHaveLength(2);
    expect(all.holder).toBeNull();
    const cellsOnly = (await fx.call(gridRoute, holder, 'GET', { query: { version_id: v, cells_only: '1' } })).body.data as { cells: unknown[] };
    expect(cellsOnly.cells).toHaveLength(1);
  });
});

describe('version approve and slices (decision 9a)', () => {
  it('refused while a slice is not approved; an admin cannot force; the owner forces with a reason (audited); all approved needs no force', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    const r = await approveVersion(w.u, v);
    expect([r.status, errCodeOf(r)], dump(r)).toEqual([409, 'BUDGET_SLICES_PENDING']);
    expect(String(r.body.error?.message)).toContain('CC1 GS-C1 (open)');
    expect((await approveVersion(admin, v, { force: true, reason: 'x' })).status).toBe(403);
    expect((await approveVersion(w.u, v, { force: true, reason: '   ' })).status).toBe(400);
    expect((await pool.query('SELECT status FROM budget_versions WHERE id = $1', [v])).rows[0].status).toBe('draft');
    const forced = await approveVersion(w.u, v, { force: true, reason: 'Board meets today' });
    expect(forced.status, dump(forced)).toBe(200);
    const audit = (await fx.audits(v)).find((a) => a.changes.metadata?.forcedApproval === 'true');
    expect(audit?.changes.metadata).toMatchObject({ reason: 'Board meets today', pendingSlices: '1', slices: 'CC1 GS-C1 (open)' });

    const v2 = await fx.version(w);
    const s2 = await fx.hold(w, v2, holder.userId, { bu: w.bu });
    await fx.setStatus(s2, 'submitted', holder.userId);
    await fx.setStatus(s2, 'approved', w.u.userId);
    expect((await approveVersion(admin, v2)).status).toBe(200);
    expect(slice).toBeTruthy();
  });

  it('a manager cannot delete a draft that has holders; the owner can', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    const r = await fx.call(versionRoute, manager, 'DELETE', { query: { id: v } });
    expect([r.status, errCodeOf(r)], dump(r)).toEqual([403, 'BUDGET_VERSION_FORBIDDEN']);
    expect((await fx.call(versionRoute, w.u, 'DELETE', { query: { id: v } })).status).toBe(200);
  });
});
