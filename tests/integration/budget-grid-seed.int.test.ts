/**
 * Budgets P2 create wizard (spec 8): POST /api/accounting/budget-grid/seed called as real members
 * through withAuth's request transaction. PY actuals +x% and copy-version +x% use the one `uplift`
 * (target = roundToUnit(sum x (1+x)), residue on the last month, negative PY months kept), at
 * company or dimension grain (never two grains for one account), as a draft, in ONE transaction
 * (a fault after the version insert leaves no version), and make-primary only for owner/admin.
 * Expected figures are worked by hand in the comments, not recomputed with the code under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import seedRoute from '../../pages/api/accounting/budget-grid/seed';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const URL = '/api/accounting/budget-grid/seed';
const MARKER = `SEED-FAULT-${crypto.randomUUID().slice(0, 8)}`;
const extraUsers: string[] = [];

let A: GridCo, B: GridCo, T: GridCo;
let manager: SetupUser, admin: SetupUser;

type Source = Record<string, unknown>;
const body = (name: string, source: Source, extra: Record<string, unknown> = {}) =>
  ({ fiscalYear: 2027, name, kind: 'scenario', makePrimary: false, roundingUnit: 1, source, ...extra });
const py = (upliftPct: number, grain = 'company', extra: Source = {}): Source => ({ type: 'py_actuals', upliftPct, grain, ...extra });
const seed = (c: GridCo, b: unknown, u: SetupUser = c.owner) => fx.call(seedRoute, URL, u, 'POST', {}, b);
const out = (r: { body: { data?: unknown } }) => r.body.data as { versionId: string; updatedAt: string; cells: number; skippedAccounts: number };
const code = (r: { body: { error?: { details?: { code?: string } } } }) => r.body.error?.details?.code;
const dump = (r: { status: number; body: unknown }) => JSON.stringify(r.body).slice(0, 300);

async function rows(versionId: string, acct?: string) {
  return (await pool.query(
    `SELECT gl_account_id AS acct, to_char(month, 'YYYY-MM') AS m, amount::text AS amt, cc1_id, cc2_id, bu_id FROM budget_month_amounts
      WHERE version_id = $1 AND ($2::uuid IS NULL OR gl_account_id = $2) ORDER BY gl_account_id, month, cc1_id`, [versionId, acct ?? null])).rows as
    Array<{ acct: string; m: string; amt: string; cc1_id: string | null; cc2_id: string | null; bu_id: string | null }>;
}
/** month -> amount for one account's company-level rows. */
const byMonth = async (versionId: string, acct: string) => Object.fromEntries((await rows(versionId, acct)).map((r) => [r.m, Number(r.amt)]));
const versionRow = async (id: string) => (await pool.query('SELECT status, is_primary, based_on_version_id FROM budget_versions WHERE id = $1', [id])).rows[0];
const countNamed = async (c: GridCo, name: string) => Number((await pool.query('SELECT COUNT(*) n FROM budget_versions WHERE company_id = $1 AND name = $2', [c.id, name])).rows[0].n);

async function member(c: GridCo, role: string): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [c.id, userId, role]);
  extraUsers.push(userId);
  return { userId, homeCompanyId: c.id, token: await signSession(userId, undefined, 'aal2') };
}

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  T = await fx.company({ transition: true });
  manager = await member(A, 'manager');
  admin = await member(A, 'admin');
  const { sales, rent, childA, header, inactive } = A.acct;

  // Prior year of FY2027 is Mar 2025 - Feb 2026. Sales (PY, rand): Mar 12345.67, Apr 20000, May 3456.78, Jun 1000, Feb 9999.99.
  for (const [d, v] of [['2025-03-10', 12345.67], ['2025-04-10', 20000], ['2025-05-10', 3456.78], ['2025-06-10', 1000], ['2026-02-20', 9999.99]] as const) {
    await fx.journal(A, d, [{ acct: sales, credit: v }]);
  }
  // Rent: Apr 280 (300 Dr, 20 Cr), May -150 (a credit on an expense), Aug 1000.
  await fx.journal(A, '2025-04-02', [{ acct: rent, debit: 300 }]);
  await fx.journal(A, '2025-04-03', [{ acct: rent, credit: 20 }]);
  await fx.journal(A, '2025-05-02', [{ acct: rent, credit: 150 }]);
  await fx.journal(A, '2025-08-02', [{ acct: rent, debit: 1000 }]);
  await fx.journal(A, '2025-06-02', [{ acct: childA, debit: 40 }]);
  // Activity on a header and on an inactive account: never seeded (decision 18).
  await fx.journal(A, '2025-06-03', [{ acct: header, debit: 99 }]);
  await fx.journal(A, '2025-06-04', [{ acct: inactive, debit: 98 }]);
  await fx.journal(A, '2025-06-05', [{ acct: sales, credit: 7777 }], { status: 'draft' });

  // Company B: dimension grain. Sales Mar: cc1 1000, cc1b 500, untagged 200; Apr cc1 2000. Rent May: cc1 300 only.
  await fx.journal(B, '2025-03-10', [{ acct: B.acct.sales, credit: 1000, cc1: B.cc1 }]);
  await fx.journal(B, '2025-03-11', [{ acct: B.acct.sales, credit: 500, cc1: B.cc1b }]);
  await fx.journal(B, '2025-03-12', [{ acct: B.acct.sales, credit: 200 }]);
  await fx.journal(B, '2025-04-10', [{ acct: B.acct.sales, credit: 2000, cc1: B.cc1 }]);
  await fx.journal(B, '2025-05-10', [{ acct: B.acct.rent, debit: 300, cc1: B.cc1 }]);

  // The fault: a trigger that raises on the amounts insert of the version named MARKER.
  await pool.query(`
    CREATE OR REPLACE FUNCTION budget_seed_fault_fn() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF EXISTS (SELECT 1 FROM budget_versions v WHERE v.id = NEW.version_id AND v.name = '${MARKER}') THEN
        RAISE EXCEPTION 'seed fault injected' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $f$`);
  await pool.query(`CREATE TRIGGER zz_seed_fault BEFORE INSERT ON budget_month_amounts FOR EACH ROW EXECUTE FUNCTION budget_seed_fault_fn()`);
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DROP TRIGGER IF EXISTS zz_seed_fault ON budget_month_amounts');
    await pool.query('DROP FUNCTION IF EXISTS budget_seed_fault_fn()');
    await fx.cleanup();
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [extraUsers]);
  } finally {
    await pool.end();
  }
}, 60000);

describe('POST /api/accounting/budget-grid/seed', () => {
  it('PY actuals +10% at R1000: each account totals roundToUnit(PY x 1.1), the residue lands on the last month, a draft', async () => {
    const r = await seed(A, { ...body('PY10', py(10)), roundingUnit: 1000 });
    expect(r.status, dump(r)).toBe(200);
    const { versionId, cells, updatedAt } = out(r);
    // Sales PY 46802.44 x 1.1 = 51482.684 -> 51000. Months 1-11: Mar 13580.24 -> 14000, Apr 22000, May 3802.46 -> 4000,
    // Jun 1100 -> 1000, the rest 0; last (Feb) = 51000 - 41000 = 10000 (not 9999.99 x 1.1 = 11000).
    expect(await byMonth(versionId, A.acct.sales)).toEqual({
      '2026-03': 14000, '2026-04': 22000, '2026-05': 4000, '2026-06': 1000, '2026-07': 0, '2026-08': 0, '2026-09': 0,
      '2026-10': 0, '2026-11': 0, '2026-12': 0, '2027-01': 0, '2027-02': 10000,
    });
    // Rent PY 1130 x 1.1 = 1243 -> 1000; Apr 308 -> 0, May -165 -> 0, Aug 1100 -> 1000, last = 1000 - 1000 = 0.
    const rent = await byMonth(versionId, A.acct.rent);
    expect(Object.values(rent).reduce((s, x) => s + x, 0)).toBe(1000);
    expect(rent['2026-08']).toBe(1000);
    // childA (a leaf) is seeded; the header, the inactive account and the draft journal's amounts are not.
    expect((await rows(versionId, A.acct.header)).length).toBe(0);
    expect((await rows(versionId, A.acct.inactive)).length).toBe(0);
    expect((await rows(versionId, A.acct.cos)).length).toBe(0);
    expect(Object.values(await byMonth(versionId, A.acct.childA)).reduce((s, x) => s + x, 0)).toBe(0);
    expect(cells).toBe((await rows(versionId)).length);
    expect(cells).toBe(36);
    expect(out(r).skippedAccounts).toBe(2);
    expect(await versionRow(versionId)).toMatchObject({ status: 'draft', is_primary: false, based_on_version_id: null });
    const token = (await pool.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t FROM budget_versions WHERE id = $1`, [versionId])).rows[0].t;
    expect(updatedAt).toBe(token);
    const audits = (await pool.query(`SELECT action, changes FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1`, [versionId])).rows;
    expect(audits.filter((a) => a.changes?.metadata?.cells === '36').length).toBe(1);
  });

  it('negative PY months are kept: R1 +10%', async () => {
    const r = await seed(A, body('PY10-R1', py(10)));
    expect(r.status, dump(r)).toBe(200);
    // Rent PY: Apr 280, May -150, Aug 1000 (sum 1130 -> 1243). Apr 308, May -165, Aug 1100, last = 1243 - 1243 = 0.
    const rent = await byMonth(out(r).versionId, A.acct.rent);
    expect(rent['2026-04']).toBe(308);
    expect(rent['2026-05']).toBe(-165);
    expect(rent['2026-08']).toBe(1100);
    expect(rent['2027-02']).toBe(0);
  });

  it('includeNoActivity adds a zero company-level row set for leaf accounts with no PY, never headers or inactive ones', async () => {
    const r = await seed(A, body('PY-ALL', py(0), { includeNoActivity: true }));
    expect(r.status, dump(r)).toBe(200);
    const v = out(r).versionId;
    expect(Object.keys(await byMonth(v, A.acct.cos)).length).toBe(12);
    expect(Object.values(await byMonth(v, A.acct.cos)).every((x) => x === 0)).toBe(true);
    expect((await rows(v, A.acct.header)).length).toBe(0);
    expect((await rows(v, A.acct.inactive)).length).toBe(0);
  });

  it('copy version +5% in the same FY keeps the months the source has, uplifted with the residue on its last month', async () => {
    const src = await fx.version(A, { name: 'COPY-SRC' });
    await fx.amount(A, src, A.acct.sales, '2026-03', 1000.5);
    await fx.amount(A, src, A.acct.sales, '2026-04', 2000);
    await fx.amount(A, src, A.acct.sales, '2027-02', 500);
    await fx.amount(A, src, A.acct.bank, '2026-03', 77); // a balance-sheet leftover is not carried
    const r = await seed(A, body('COPY5', { type: 'version', versionId: src, upliftPct: 5 }));
    expect(r.status, dump(r)).toBe(200);
    // 3 months, sum 3500.50 x 1.05 = 3675.525 -> 3676. Mar 1050.525 -> 1051, Apr 2100, last = 3676 - 3151 = 525.
    expect(await byMonth(out(r).versionId, A.acct.sales)).toEqual({ '2026-03': 1051, '2026-04': 2100, '2027-02': 525 });
    expect(out(r).cells).toBe(3);
    expect(await versionRow(out(r).versionId)).toMatchObject({ status: 'draft', is_primary: false });
  });

  it('copy version at 0% in the same FY is the exact P1 copy, dimensions and cents included', async () => {
    const src = await fx.version(A, { name: 'COPY-EXACT' });
    await fx.amount(A, src, A.acct.sales, '2026-03', 1000.55, { cc1: A.cc1 });
    await fx.amount(A, src, A.acct.rent, '2026-04', 12.34);
    const r = await seed(A, body('COPY0', { type: 'version', versionId: src, upliftPct: 0 }, { roundingUnit: 1000 }));
    expect(r.status, dump(r)).toBe(200);
    expect(await versionRow(out(r).versionId)).toMatchObject({ status: 'draft', based_on_version_id: src });
    const copied = await rows(out(r).versionId);
    expect(copied.map((x) => [x.m, x.amt, x.cc1_id])).toEqual(expect.arrayContaining([['2026-04', '12.34', null], ['2026-03', '1000.55', A.cc1]]));
    expect(out(r).cells).toBe(2);
  });

  it('copy version from another FY maps months by position; a 12-month year into a 14-month transition year', async () => {
    const src = await fx.version(A, { fy: 2026, name: 'FY26-SRC' });
    await fx.amount(A, src, A.acct.sales, '2025-03', 100);
    await fx.amount(A, src, A.acct.sales, '2025-04', 200);
    const r = await seed(A, body('FROM26', { type: 'version', versionId: src, upliftPct: 0 }));
    expect(r.status, dump(r)).toBe(200);
    expect(await byMonth(out(r).versionId, A.acct.sales)).toEqual({ '2026-03': 100, '2026-04': 200 });

    const tsrc = await fx.version(T, { fy: 2025, name: 'T25-SRC' });
    await fx.amount(T, tsrc, T.acct.sales, '2025-01', 10);
    await fx.amount(T, tsrc, T.acct.sales, '2025-12', 30);
    const t = await seed(T, body('T-FROM25', { type: 'version', versionId: tsrc, upliftPct: 0 }));
    expect(t.status, dump(t)).toBe(200);
    expect(await byMonth(out(t).versionId, T.acct.sales)).toEqual({ '2026-01': 10, '2026-12': 30 });
  });

  it('dimension grain: an account with untagged PY becomes company grain entirely (default), or keeps only its tagged series with unassigned drop', async () => {
    const a = await seed(B, body('DIM-COMPANY', py(0, 'cc1')));
    expect(a.status, dump(a)).toBe(200);
    // Sales has untagged activity: one company-level series 1700 (Mar), 2000 (Apr). Rent is all cc1.
    const sales = await rows(out(a).versionId, B.acct.sales);
    expect(sales.every((x) => x.cc1_id === null)).toBe(true);
    expect(await byMonth(out(a).versionId, B.acct.sales)).toMatchObject({ '2026-03': 1700, '2026-04': 2000 });
    const rent = await rows(out(a).versionId, B.acct.rent);
    expect(rent.length).toBe(12);
    expect(rent.every((x) => x.cc1_id === B.cc1)).toBe(true);
    expect(rent.find((x) => x.m === '2026-05')?.amt).toBe('300.00');

    const d = await seed(B, body('DIM-DROP', py(0, 'cc1', { unassigned: 'drop' })));
    expect(d.status, dump(d)).toBe(200);
    const sd = await rows(out(d).versionId, B.acct.sales);
    expect(sd.filter((x) => x.cc1_id === B.cc1).map((x) => [x.m, x.amt]).filter(([, v]) => v !== '0.00')).toEqual([['2026-03', '1000.00'], ['2026-04', '2000.00']]);
    expect(sd.filter((x) => x.cc1_id === B.cc1b).find((x) => x.m === '2026-03')?.amt).toBe('500.00');
    expect(sd.some((x) => x.cc1_id === null)).toBe(false);
    for (const v of [out(a).versionId, out(d).versionId]) {
      const g = await pool.query('SELECT gl_account_id, COUNT(DISTINCT dim_grain) n FROM budget_month_amounts WHERE version_id = $1 GROUP BY 1', [v]);
      expect(g.rows.every((x) => Number(x.n) === 1)).toBe(true);
    }
  });

  it('blank creates an empty draft', async () => {
    const r = await seed(A, body('BLANK', { type: 'blank' }));
    expect(r.status, dump(r)).toBe(200);
    expect(out(r).cells).toBe(0);
    expect(await versionRow(out(r).versionId)).toMatchObject({ status: 'draft', is_primary: false });
  });

  it('make primary: owner and admin may, a manager is refused with nothing created', async () => {
    const m = await seed(A, body('PRIM-MGR', { type: 'blank' }, { makePrimary: true }), manager);
    expect(m.status, dump(m)).toBe(403);
    expect(code(m)).toBe('BUDGET_VERSION_FORBIDDEN');
    expect(await countNamed(A, 'PRIM-MGR')).toBe(0);
    const o = await seed(A, body('PRIM-OWNER', { type: 'blank' }, { makePrimary: true }));
    expect(o.status, dump(o)).toBe(200);
    expect((await versionRow(out(o).versionId)).is_primary).toBe(true);
    const ad = await seed(A, body('PRIM-ADMIN', py(0), { makePrimary: true }), admin);
    expect(ad.status, dump(ad)).toBe(200);
    expect((await versionRow(out(ad).versionId)).is_primary).toBe(true);
    expect((await versionRow(out(o).versionId)).is_primary).toBe(false);
    const mgr = await seed(A, body('NOPRIM-MGR', { type: 'blank' }), manager);
    expect(mgr.status, dump(mgr)).toBe(200);
  });

  it('is one transaction: a fault after the version insert leaves no version, no amounts and no audit row', async () => {
    const r = await seed(A, body(MARKER, py(10)));
    expect(r.status).toBe(500);
    expect(await countNamed(A, MARKER)).toBe(0);
    const stray = await pool.query(`SELECT COUNT(*) n FROM audit_log WHERE company_id = $1 AND entity_ref LIKE $2`, [A.id, `%${MARKER}%`]);
    expect(Number(stray.rows[0].n)).toBe(0);
  });

  it('refuses without writing: viewer 403, foreign source version 404, uplift out of range 422, taken name 409', async () => {
    expect((await seed(A, body('X-VIEWER', { type: 'blank' }), A.viewer)).status).toBe(403);
    const foreign = await fx.version(B, { name: 'B-SRC' });
    await fx.amount(B, foreign, B.acct.sales, '2026-03', 5);
    const f = await seed(A, body('X-FOREIGN', { type: 'version', versionId: foreign, upliftPct: 0 }));
    expect(f.status, dump(f)).toBe(404);
    const hi = await seed(A, body('X-HIGH', py(1000.5)));
    expect(hi.status, dump(hi)).toBe(422);
    const lo = await seed(A, body('X-LOW', py(-100.5)));
    expect(lo.status, dump(lo)).toBe(422);
    const dup = await seed(A, body('PY10', py(0)));
    expect(dup.status, dump(dup)).toBe(409);
    for (const n of ['X-VIEWER', 'X-FOREIGN', 'X-HIGH', 'X-LOW']) expect(await countNamed(A, n), n).toBe(0);
    expect(await countNamed(A, 'PY10')).toBe(1);
  });
});
