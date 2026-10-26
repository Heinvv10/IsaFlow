/**
 * Budgets P1 routes (migration 947), called as real members through withAuth's request
 * transaction: pages/api/accounting/budget-versions/** and the budget save on a locked primary.
 * Roles (decision 1), 409 before any write, compare-and-set on status, 404 for another tenant's
 * id, the copy's count and sum, and one audit row per amount write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import budgetsRoute from '../../pages/api/accounting/budgets';
import listRoute from '../../pages/api/accounting/budget-versions/index';
import oneRoute from '../../pages/api/accounting/budget-versions/[id]/index';
import statusRoute from '../../pages/api/accounting/budget-versions/[id]/status';
import copyRoute from '../../pages/api/accounting/budget-versions/[id]/copy';
import primaryRoute from '../../pages/api/accounting/budget-versions/[id]/primary';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const budgets = budgetsRouteFixture(pool, budgetsRoute, '/api/accounting/budgets');
const list = budgetsRouteFixture(pool, listRoute, '/api/accounting/budget-versions');
const one = budgetsRouteFixture(pool, oneRoute, '/api/accounting/budget-versions/[id]');
const status = budgetsRouteFixture(pool, statusRoute, '/api/accounting/budget-versions/[id]/status');
const copy = budgetsRouteFixture(pool, copyRoute, '/api/accounting/budget-versions/[id]/copy');
const primary = budgetsRouteFixture(pool, primaryRoute, '/api/accounting/budget-versions/[id]/primary');

const members: string[] = [];
async function member(companyId: string, role: string): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, userId, role]);
  members.push(userId);
  return { userId, homeCompanyId: companyId, token: await signSession(userId, undefined, 'aal2') };
}

let o: Awaited<ReturnType<typeof budgets.owner>>;
let admin: SetupUser, manager: SetupUser, viewer: SetupUser;
let other: Awaited<ReturnType<typeof budgets.owner>>;

beforeAll(async () => {
  o = await budgets.owner();
  other = await budgets.owner();
  admin = await member(o.u.homeCompanyId, 'admin');
  manager = await member(o.u.homeCompanyId, 'manager');
  viewer = await member(o.u.homeCompanyId, 'viewer');
}, 60000);
afterAll(async () => {
  try {
    for (const c of [o.u.homeCompanyId, other.u.homeCompanyId]) {
      await pool.query(
        `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = now(), unlock_reason = 'cleanup'
          WHERE company_id = $1 AND status = 'locked'`, [c]);
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM budget_month_amounts WHERE company_id = $1', [c]);
      await pool.query('DELETE FROM budget_versions WHERE company_id = $1', [c]);
    }
    await budgets.cleanup();
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [members]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [members]);
  } finally {
    await pool.end();
  }
}, 60000);

type V = { id: string; status: string; isPrimary: boolean; updatedAt: string; amountCount: number; total: number; name: string };
const data = (r: { body: { data?: unknown } }) => r.body.data as V;
const errCode = (r: { body: { error?: unknown } }) => (r.body.error as { details?: { code?: string } } | undefined)?.details?.code;
const months = (amount: number) => o.months.map((month) => ({ month, amount }));
const create = async (u: SetupUser, name: string, kind = 'scenario', fiscalYear = o.label) =>
  list.call(u, 'POST', { fiscalYear, name, kind });
const move = (u: SetupUser, id: string, body: Record<string, unknown>) => status.call(u, 'POST', body, { id });
const auditCount = async (entityId: string) =>
  Number((await pool.query('SELECT COUNT(*) n FROM audit_log WHERE entity_id = $1', [entityId])).rows[0].n);

describe('budget-versions routes', () => {
  it('roles: admin approves and locks; a manager (a writer) cannot approve or lock; an admin cannot unlock; the owner unlocks only with a reason', async () => {
    const v = data(await create(o.u, 'Roles'));
    const m = await move(manager, v.id, { action: 'approve' });
    expect([m.status, errCode(m)]).toEqual([403, 'BUDGET_VERSION_FORBIDDEN']);
    expect((await move(viewer, v.id, { action: 'approve' })).status).toBe(403);
    expect((await move(admin, v.id, { action: 'approve' })).status).toBe(200);
    expect((await move(manager, v.id, { action: 'lock' })).status).toBe(403);
    expect((await move(admin, v.id, { action: 'lock' })).status).toBe(200);
    expect((await move(admin, v.id, { action: 'unlock', reason: 'x' })).status).toBe(403);
    expect((await primary.call(manager, 'POST', undefined, { id: v.id })).status).toBe(403);
    const noReason = await move(o.u, v.id, { action: 'unlock', reason: '  ' });
    expect(noReason.status).toBe(400);
    const ok = await move(o.u, v.id, { action: 'unlock', reason: 'Board revised Q3' });
    expect(ok.status, JSON.stringify(ok.body).slice(0, 200)).toBe(200);
    expect(data(ok).status).toBe('approved');
  });

  it('a save into a locked primary is 409 BUDGET_VERSION_LOCKED, writes nothing, and the transaction is not poisoned', async () => {
    const saved = await budgets.call(o.u, 'POST', { glAccountId: o.account, fiscalYear: o.label, months: months(10), notes: 'first' });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 200)).toBe(200);
    const prim = (await pool.query('SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = $2 AND is_primary', [o.u.homeCompanyId, o.label])).rows[0].id;
    expect((await move(o.u, prim, { action: 'approve' })).status).toBe(200);
    expect((await move(o.u, prim, { action: 'lock' })).status).toBe(200);
    const before = (await pool.query('SELECT COUNT(*)::int n, SUM(amount)::text s FROM budget_month_amounts WHERE version_id = $1', [prim])).rows[0];
    const r = await budgets.call(o.u, 'POST', { glAccountId: o.account, fiscalYear: o.label, months: months(99), notes: 'second' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(409);
    expect(errCode(r)).toBe('BUDGET_VERSION_LOCKED');
    expect((await pool.query('SELECT COUNT(*)::int n, SUM(amount)::text s FROM budget_month_amounts WHERE version_id = $1', [prim])).rows[0]).toEqual(before);
    const note = (await pool.query('SELECT notes FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2', [o.u.homeCompanyId, o.account])).rows[0].notes;
    expect(note).toBe('first');
    // Deleting the locked primary's account budget is refused the same way.
    const del = await budgetsRouteFixture(pool, (await import('../../pages/api/accounting/budgets-action')).default, '/api/accounting/budgets-action')
      .call(o.u, 'POST', { action: 'delete', glAccountId: o.account, fiscalYear: o.label });
    expect(del.status).toBe(409);
    expect((await move(o.u, prim, { action: 'unlock', reason: 'reopen for the next cases' })).status).toBe(200);
  });

  it('a company-level save for an account budgeted by dimension is 400 BUDGET_GRAIN_CONFLICT naming the account', async () => {
    const x = await budgets.owner();
    await budgets.call(x.u, 'POST', { glAccountId: x.account, fiscalYear: x.label, months: months(0).map((m, i) => ({ ...m, month: x.months[i]! })) });
    const prim = (await pool.query('SELECT id FROM budget_versions WHERE company_id = $1 AND is_primary', [x.u.homeCompanyId])).rows[0].id;
    const cc = (await pool.query(`INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'G-1', 'G', 'cc1') RETURNING id`, [x.u.homeCompanyId])).rows[0].id;
    await pool.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [prim]);
    await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, month, amount) VALUES ($1, $2, $3, $4, $5, 1)`,
      [x.u.homeCompanyId, prim, x.account, cc, `${x.months[0]}-01`]);
    const r = await budgets.call(x.u, 'POST', { glAccountId: x.account, fiscalYear: x.label, annualAmount: 1200 });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
    expect(errCode(r)).toBe('BUDGET_GRAIN_CONFLICT');
    expect((r.body.error as { message: string }).message).toContain('BR-5000');
    await pool.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [prim]);
    await pool.query('DELETE FROM cost_centres WHERE id = $1', [cc]);
  });

  it('copy reproduces the count and sum; a second original is 409; the primary and a locked version cannot be deleted', async () => {
    const prim = (await pool.query('SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = $2 AND is_primary', [o.u.homeCompanyId, o.label])).rows[0].id;
    const src = data(await one.call(o.u, 'GET', undefined, { id: prim }));
    const c = await copy.call(o.u, 'POST', { name: 'Copy of original', kind: 'reforecast' }, { id: prim });
    expect(c.status, JSON.stringify(c.body).slice(0, 200)).toBe(201);
    expect([data(c).amountCount, data(c).total, data(c).status, data(c).isPrimary]).toEqual([src.amountCount, src.total, 'draft', false]);
    expect(src.amountCount).toBe(12);
    const second = await create(o.u, 'Another original', 'original');
    expect(second.status).toBe(409);
    expect((await one.call(o.u, 'DELETE', undefined, { id: prim })).status).toBe(409);
    const l = data(await create(o.u, 'To lock'));
    await move(o.u, l.id, { action: 'approve' });
    await move(o.u, l.id, { action: 'lock' });
    const dl = await one.call(o.u, 'DELETE', undefined, { id: l.id });
    expect([dl.status, errCode(dl)]).toEqual([409, 'BUDGET_VERSION_LOCKED']);
    // An approved version: a manager may not delete it, an admin may; a draft any writer may.
    const ap = data(await create(o.u, 'Approved one'));
    await move(o.u, ap.id, { action: 'approve' });
    expect((await one.call(manager, 'DELETE', undefined, { id: ap.id })).status).toBe(403);
    expect((await one.call(admin, 'DELETE', undefined, { id: ap.id })).status).toBe(200);
    expect((await one.call(manager, 'DELETE', undefined, { id: data(c).id })).status).toBe(200);
  });

  it('two concurrent approves: one 200, one 409; a stale expectedUpdatedAt is 409 STALE', async () => {
    const v = data(await create(o.u, 'Race'));
    const [a, b] = await Promise.all([move(o.u, v.id, { action: 'approve' }), move(admin, v.id, { action: 'approve' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const w = data(await create(o.u, 'Stale'));
    const fresh = data(await one.call(o.u, 'GET', undefined, { id: w.id }));
    await pool.query(`UPDATE budget_versions SET name = 'Stale renamed' WHERE id = $1`, [w.id]);
    const r = await move(o.u, w.id, { action: 'approve', expectedUpdatedAt: fresh.updatedAt });
    expect([r.status, errCode(r)]).toEqual([409, 'BUDGET_VERSION_STALE']);
  });

  it("another tenant's version id is 404 on every route", async () => {
    const theirs = data(await create(other.u, 'Theirs', 'scenario', other.label));
    expect((await one.call(o.u, 'GET', undefined, { id: theirs.id })).status).toBe(404);
    expect((await one.call(o.u, 'DELETE', undefined, { id: theirs.id })).status).toBe(404);
    expect((await move(o.u, theirs.id, { action: 'approve' })).status).toBe(404);
    expect((await copy.call(o.u, 'POST', { name: 'steal', kind: 'scenario' }, { id: theirs.id })).status).toBe(404);
    expect((await primary.call(o.u, 'POST', undefined, { id: theirs.id })).status).toBe(404);
    expect((await budgets.call(o.u, 'GET', undefined, { fiscal_year: String(o.label), versionId: theirs.id })).status).toBe(404);
  });

  it('each amount write is exactly one audit row on the version; list and primary work', async () => {
    const x = await budgets.owner();
    await budgets.call(x.u, 'POST', { glAccountId: x.account, fiscalYear: x.label, annualAmount: 1200 });
    const prim = (await pool.query('SELECT id FROM budget_versions WHERE company_id = $1 AND is_primary', [x.u.homeCompanyId])).rows[0].id;
    expect(await auditCount(prim)).toBe(1);
    await budgets.call(x.u, 'POST', { glAccountId: x.account, fiscalYear: x.label, annualAmount: 2400 });
    expect(await auditCount(prim)).toBe(2);
    const items = (await list.call(x.u, 'GET', undefined, { fiscalYear: String(x.label) })).body.data as unknown as { items: V[] };
    expect(items.items.map((i) => [i.name, i.isPrimary, i.total])).toEqual([['Original', true, 2400]]);
    const alt = data(await create(x.u, 'Alt', 'scenario', x.label));
    const p = await primary.call(x.u, 'POST', undefined, { id: alt.id });
    expect([p.status, data(p).isPrimary]).toEqual([200, true]);
    // The budgets page now reads the new primary: empty.
    const page = await budgets.call(x.u, 'GET', undefined, { fiscal_year: String(x.label) });
    expect(((page.body.data as unknown as { items: unknown[] }).items)).toEqual([expect.objectContaining({ annualAmount: 0 })]);
  });
});
