/**
 * Budgets P5-6, migration 955 on its own (spec §2 "DB-level rule", decision 9a, §7 "holder outside
 * slice refused at DB"): every statement runs AS app_user with a member's claims, the way withAuth
 * runs a request, and no application code is involved.
 * - budget_month_amounts_slice_guard: a holder writes only inside their slices of a draft version;
 *   a submitted or approved slice is changed only on the reviewer path, which needs BOTH the
 *   transaction-local GUC (budget_slice_review_begin) AND an owner or admin session (a forged GUC
 *   alone opens nothing); an approved version has no slice lock.
 * - budget_holders_rules / budget_slice_reviews_rules: who assigns, who may hold, which moves.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetHoldersFixture, insertAmountSql, type GridWorld } from './helpers/budgetHoldersFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let holder: SetupUser;
let manager: SetupUser;
let viewer: SetupUser;
let admin: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  manager = await fx.member(w.u.homeCompanyId, 'manager');
  viewer = await fx.member(w.u.homeCompanyId, 'viewer');
  admin = await fx.member(w.u.homeCompanyId, 'admin');
}, 120_000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120_000);

const owner = () => w.u;
/** One amount written as the session (company of `w`). */
const put = (c: PoolClient, versionId: string, acct: string, amount: number, dims: { cc1?: string; cc2?: string; bu?: string } = {}, month = w.months[0]!) =>
  c.query(insertAmountSql, [w.u.homeCompanyId, versionId, acct, month, amount, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null]);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

describe('budget_month_amounts_slice_guard as app_user', () => {
  it('a holder writes inside their slice; outside it (another slice, the company level, an account not theirs) is BV004', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 }, { accounts: [w.rent] });
    await fx.asMember(holder, async (c) => {
      await put(c, v, w.rent, 10, { cc1: w.cc1 });
      expect(await code(c.query('SAVEPOINT a').then(() => put(c, v, w.sales, 10, { cc2: w.cc2 })))).toBe('BV004');
      await c.query('ROLLBACK TO SAVEPOINT a');
      expect(await code(put(c, v, w.child2, 10))).toBe('BV004');
      await c.query('ROLLBACK TO SAVEPOINT a');
      expect(await code(put(c, v, w.child1, 10, { cc1: w.cc1 }))).toBe('BV004');
    });
  });

  it('a holder cannot update or delete a row outside their slice either (OLD is checked)', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    await fx.amount(w, v, w.sales, w.months[1]!, 5, { cc2: w.cc2 });
    await fx.asMember(holder, async (c) => {
      await c.query('SAVEPOINT a');
      expect(await code(c.query('UPDATE budget_month_amounts SET amount = 6 WHERE version_id = $1 AND cc2_id = $2', [v, w.cc2]))).toBe('BV004');
      await c.query('ROLLBACK TO SAVEPOINT a');
      expect(await code(c.query('DELETE FROM budget_month_amounts WHERE version_id = $1 AND cc2_id = $2', [v, w.cc2]))).toBe('BV004');
    });
  });

  it('a manager who holds nothing in the version writes as before (except a locked slice)', async () => {
    const v = await fx.version(w);
    await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    await fx.asMember(manager, async (c) => { await put(c, v, w.rent, 3, { cc2: w.cc2 }); await put(c, v, w.sales, 4, { cc1: w.cc1 }); });
  });

  it('a submitted slice: the holder and a manager are BV003; an owner only on the reviewer path; a forged GUC alone opens nothing', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    await fx.setStatus(slice, 'submitted', holder.userId);
    const guc = `${w.u.homeCompanyId}:${v}`;
    expect(await code(fx.asMember(holder, (c) => put(c, v, w.rent, 1, { cc1: w.cc1 })))).toBe('BV003');
    expect(await code(fx.asMember(manager, (c) => put(c, v, w.rent, 1, { cc1: w.cc1 })))).toBe('BV003');
    expect(await code(fx.asMember(owner(), (c) => put(c, v, w.rent, 1, { cc1: w.cc1 })))).toBe('BV003');
    // The manager sets the GUC by hand: the role is checked per row, so it is still refused.
    expect(await code(fx.asMember(manager, async (c) => {
      await c.query("SELECT set_config('budgets.slice_reviewer', $1, true)", [guc]);
      await put(c, v, w.rent, 1, { cc1: w.cc1 });
    }))).toBe('BV003');
    // And begin() refuses a manager outright.
    expect(await code(fx.asMember(manager, (c) => c.query('SELECT public.budget_slice_review_begin($1, $2)', [w.u.homeCompanyId, v])))).toBe('BV004');
    // The GUC names ONE version: another version's review does not open this one.
    expect(await code(fx.asMember(owner(), async (c) => {
      await c.query('SELECT public.budget_slice_review_begin($1, $2)', [w.u.homeCompanyId, await fx.version(w)]);
      await put(c, v, w.rent, 1, { cc1: w.cc1 });
    }))).toBe('BV003');
    for (const reviewer of [owner(), admin]) {
      expect(await code(fx.asMember(reviewer, async (c) => {
        await c.query('SELECT public.budget_slice_review_begin($1, $2)', [w.u.homeCompanyId, v]);
        await put(c, v, w.rent, 1, { cc1: w.cc1 });
      }))).toBe('ok');
    }
    // Other slices of the version are not locked by it.
    expect(await code(fx.asMember(manager, (c) => put(c, v, w.sales, 1, { cc2: w.cc2 })))).toBe('ok');
  });

  it('an approved slice is locked the same way; a returned one is the holder\'s again', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { bu: w.bu });
    await fx.setStatus(slice, 'submitted', holder.userId);
    await fx.setStatus(slice, 'returned', w.u.userId, 'tighten travel');
    expect(await code(fx.asMember(holder, (c) => put(c, v, w.rent, 1, { bu: w.bu })))).toBe('ok');
    await fx.setStatus(slice, 'submitted', holder.userId);
    await fx.setStatus(slice, 'approved', w.u.userId);
    expect(await code(fx.asMember(holder, (c) => put(c, v, w.rent, 1, { bu: w.bu })))).toBe('BV003');
  });

  it('on an approved version there is no slice lock (P1 rules apply), and a holder writes nothing', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    await fx.setStatus(slice, 'submitted', holder.userId);
    await fx.setStatus(slice, 'approved', w.u.userId);
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [v, w.u.userId]);
    expect(await code(fx.asMember(owner(), (c) => put(c, v, w.rent, 1, { cc1: w.cc1 })))).toBe('ok');
    expect(await code(fx.asMember(holder, (c) => put(c, v, w.rent, 1, { cc1: w.cc1 })))).toBe('BV004');
  });
});

describe('budget_holders_rules and budget_slice_reviews_rules as app_user', () => {
  const insertHolder = (c: PoolClient, v: string, user: string) => c.query(
    `INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, 'x')`,
    [w.u.homeCompanyId, v, user, w.cc1]);

  it('only an owner or admin assigns; the holder is a manager, admin or owner; a draft version only', async () => {
    const v = await fx.version(w);
    expect(await code(fx.asMember(owner(), (c) => insertHolder(c, v, viewer.userId)))).toBe('BV004');
    expect(await code(fx.asMember(manager, (c) => insertHolder(c, v, holder.userId)))).toBe('BV004');
    expect(await code(fx.asMember(admin, (c) => insertHolder(c, v, holder.userId)))).toBe('ok');
    const approved = await fx.version(w, { status: 'approved' });
    expect(await code(fx.asMember(owner(), (c) => insertHolder(c, approved, holder.userId)))).toBe('BV005');
  });

  it('moves: a holder submits only their own slice; only an owner/admin approves or returns, a return needs a note; nothing else moves', async () => {
    const v = await fx.version(w);
    const mine = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    const theirs = await fx.hold(w, v, manager.userId, { cc2: w.cc2 });
    const move = (u: SetupUser, id: string, s: string, note: string | null = null) => code(fx.asMember(u, (c) =>
      c.query('UPDATE budget_slice_reviews SET status = $2, decision_note = $3 WHERE id = $1', [id, s, note])));
    expect(await move(holder, theirs, 'submitted')).toBe('BV004');
    expect(await move(holder, mine, 'approved')).toBe('BV005');
    expect(await move(holder, mine, 'submitted')).toBe('ok');
    await fx.setStatus(mine, 'submitted', holder.userId);
    expect(await move(holder, mine, 'approved')).toBe('BV004');
    expect(await move(manager, mine, 'returned', 'no')).toBe('BV004');
    expect(await move(owner(), mine, 'returned', '  ')).toBe('BV005');
    expect(await move(owner(), mine, 'returned', 'fix it')).toBe('ok');
    expect(await move(admin, mine, 'approved')).toBe('ok');
    await fx.setStatus(mine, 'approved', w.u.userId);
    expect(await move(owner(), mine, 'open')).toBe('BV005');
    // Reopening an approved slice (r6): a reviewer, with a note.
    expect(await move(owner(), mine, 'returned', '  ')).toBe('BV005');
    expect(await move(manager, mine, 'returned', 'late')).toBe('BV004');
    expect(await move(owner(), mine, 'returned', 'late')).toBe('ok');
    // Re-dating and removing a slice review are the reviewer's.
    expect(await code(fx.asMember(holder, (c) => c.query(`UPDATE budget_slice_reviews SET due_date = '2030-01-01' WHERE id = $1`, [mine])))).toBe('BV004');
    expect(await code(fx.asMember(holder, (c) => c.query('DELETE FROM budget_slice_reviews WHERE id = $1', [mine])))).toBe('BV004');
    expect(await code(fx.asMember(owner(), (c) => c.query('DELETE FROM budget_slice_reviews WHERE id = $1', [mine])))).toBe('ok');
  });

  it('a slice moves only on a draft version; a manager cannot delete a draft that has holders (the cascade is refused)', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
    expect(await code(fx.asMember(manager, (c) => c.query('DELETE FROM budget_versions WHERE id = $1', [v])))).toBe('BV004');
    expect(await code(fx.asMember(owner(), (c) => c.query('DELETE FROM budget_versions WHERE id = $1', [v])))).toBe('ok');
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [v, w.u.userId]);
    expect(await code(fx.asMember(holder, (c) => c.query(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`, [slice])))).toBe('BV005');
  });
});
