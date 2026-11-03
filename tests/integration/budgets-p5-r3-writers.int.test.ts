/**
 * Budgets P5-6 r3: the server's other budget writers on versions with budget slices (blind M1).
 * - P4 auto-roll (after a real period close) and Roll now skip the cells of a slice with its reviewer,
 *   count them (`sliceSkipped`, audited), never fail the run, and roll them once the slice is returned;
 *   a holder's Roll now is refused (403).
 * - A change of year end by the owner moves a primary's months out of an approved slice (the reviewer
 *   path, beginReviewForOwner); the seed wizard copying a version with an approved slice is unaffected
 *   (it writes a NEW version, which has no slices).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetReforecastFixture, type ReforecastWorld } from './helpers/budgetReforecastFixture';
import { dataOf, type RouteOut } from './helpers/budgetDriverRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import sliceRoute from '../../pages/api/accounting/budgets/slices/[id]/[action]';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetReforecastFixture(pool);
const sliceCall = budgetsRouteFixture(pool, sliceRoute, '/api/accounting/budgets/slices/[id]/[action]');
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;
const made: string[] = [];
const users: string[] = [];
const rollCos: string[] = [];

afterAll(async () => {
  try {
    for (const co of [...made, ...rollCos]) {
      await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM user_notifications WHERE company_id = $1', [co]);
    }
    for (const id of made) {
      for (const t of ['audit_log', 'budget_month_amounts', 'budget_versions', 'accounting_budgets', 'gl_accounts']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
      }
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120000);

/** A company-level slice of `v` held by `holder`, moved to `status` (as the holder, then the owner). */
async function slice(companyId: string, v: string, holder: string, owner: string, status: 'submitted' | 'approved'): Promise<string> {
  await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, created_by) VALUES ($1, $2, $3, 'x')`, [companyId, v, holder]);
  const id = String((await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, created_by) VALUES ($1, $2, 'x') RETURNING id`,
    [companyId, v])).rows[0].id);
  await move(id, 'submitted', holder);
  if (status === 'approved') await move(id, 'approved', owner);
  return id;
}
async function move(id: string, status: string, actor: string, note: string | null = null) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor })]);
    await c.query(`UPDATE budget_slice_reviews SET status = $2::TEXT, decision_note = CASE WHEN $2::TEXT = 'submitted' THEN decision_note ELSE $3 END WHERE id = $1`,
      [id, status, note]);
    await c.query('COMMIT');
  } finally { c.release(); }
}

describe('the forecast roll and slices', { timeout: 60000 }, () => {
  async function rollingWorld(): Promise<{ w: ReforecastWorld; m: string[]; rf: string }> {
    const w = await fx.world();
    rollCos.push(w.u.homeCompanyId);
    const m = w.months;
    const source = await fx.version(w);
    for (const month of m) await fx.amount(w, source, w.sales, month, 1000);
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);
    const r = await fx.call.reforecast(w.u, source, 'POST', { name: 'Rolling', rolling: true });
    expect(r.status, dump(r)).toBe(201);
    return { w, m, rf: dataOf<{ version: { id: string } }>(r).version.id };
  }
  const values = async (v: string, acct: string) => [...(await fx.cellsOf(v, acct)).values()];
  const rollNow = async (u: SetupUser, v: string) => fx.call.reforecast(u, v, 'POST', { action: 'roll', expectedUpdatedAt: await fx.token(v) });

  it('auto-roll and Roll now skip a submitted slice (counted, no failure) and do NOT advance the month; a holder cannot Roll now; '
    + 'returning the slice re-rolls it after commit and advances', async () => {
    const { w, m, rf } = await rollingWorld();
    const holder = await fx.member(w.u.homeCompanyId, 'manager');
    const id = await slice(w.u.homeCompanyId, rf, holder.userId, w.u.userId, 'submitted');
    const before = await values(rf, w.sales);

    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await pool.query('SELECT slice_skipped FROM budget_rolling_forecasts WHERE version_id = $1', [rf])).rows[0]?.slice_skipped > 0,
      'the after-close roll');
    expect(await fx.rollingRow(rf)).toMatchObject({ last_error: null, through: null });
    expect(await values(rf, w.sales)).toEqual(before);
    const status = await fx.call.reforecast(w.u, rf, 'GET');
    expect(dataOf(status), dump(status)).toMatchObject({ rolledThroughMonth: null, staleMonths: [m[0]], sliceSkippedSlices: ['Company level'] });
    expect(Number(dataOf<{ sliceSkipped: number }>(status).sliceSkipped)).toBeGreaterThan(0);

    const owner = await rollNow(w.u, rf);
    expect(owner.status, dump(owner)).toBe(200);
    expect(dataOf(owner)).toMatchObject({ status: 'rolled', changed: 0, rolledThroughMonth: null });
    expect(Number(dataOf<{ sliceSkipped?: number }>(owner).sliceSkipped)).toBeGreaterThan(0);
    const mine = await rollNow(holder, rf);
    expect([mine.status, (mine.body.error as { details?: { code?: string } })?.details?.code], dump(mine)).toEqual([403, 'BUDGET_SLICE_FORBIDDEN']);

    // The owner returns the slice through the route: its after-commit re-roll rolls the left cells and advances.
    const ret = await sliceCall.call(w.u, 'POST', { note: 'Refresh it' }, { id, action: 'return' });
    expect(ret.status, dump(ret)).toBe(200);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[0], 'the re-roll after the return');
    expect((await values(rf, w.sales))[0]).toBe('1200.00:actual');
    expect((await pool.query('SELECT slice_skipped, slice_skipped_slices FROM budget_rolling_forecasts WHERE version_id = $1', [rf])).rows[0])
      .toEqual({ slice_skipped: 0, slice_skipped_slices: [] });
  });
});

describe('change of year end and the seed wizard on a version with an approved slice', () => {
  const TODAY = '2026-10-23';
  const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };

  /** One request transaction as `user` (claims and company set, as withAuth's). */
  async function asRequest<T>(companyId: string, user: string, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const out = await als.run({ client, companyId, userId: user, claims: { sub: user } } as never, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }

  it('the owner\'s change of year end moves the approved slice\'s months (reviewer path); seeding a copy of it works', async () => {
    const owner = crypto.randomUUID();
    const mgr = crypto.randomUUID();
    users.push(owner, mgr);
    for (const u of [owner, mgr]) await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [u, `${u}@test.local`]);
    const id = crypto.randomUUID();
    made.push(id);
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'P5-6 rehome', 1)`, [id]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true), ($1, $3, 'manager', true)`, [id, owner, mgr]);
    const rent = String((await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
      VALUES ($1, 'RH-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [id])).rows[0].id);
    for (const d of ['2026-03-01', '2027-03-01']) await asRequest(id, owner, () => generateFiscalYearForDate(id, d));
    const versions: Record<number, string> = {};
    for (const [label, amount] of [[2026, 100], [2027, 10]] as const) {
      versions[label] = String((await pool.query(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
        VALUES ($1, $2, 'Original', 'original', true, $3) RETURNING id`, [id, label, owner])).rows[0].id);
      await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
        SELECT $1, $2, $3, make_date($4, m, 1), $5, $6 FROM generate_series(1, 12) m`, [id, versions[label], rent, label, amount, owner]);
    }
    await slice(id, versions[2027]!, mgr, owner, 'approved');

    await asRequest(id, owner, () => applyYearEndChange(id, owner, { newYearEndMonth: 2, ...OK }, TODAY));
    const moved = (await pool.query(`SELECT COUNT(*)::int n FROM budget_month_amounts WHERE version_id = $1`, [versions[2026]])).rows[0].n;
    expect(moved).toBe(14);

    const seeded = await asRequest(id, owner, () => seedVersion(id, { userId: owner, role: 'owner' }, {
      fiscalYear: 2026, name: 'Copy of approved', kind: 'scenario', makePrimary: false, roundingUnit: 1,
      source: { type: 'version', versionId: versions[2026]!, upliftPct: 0 },
    }));
    expect(seeded.versionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
