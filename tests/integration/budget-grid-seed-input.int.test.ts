/**
 * Budgets P2 create wizard, members and years (round-1 R6, SEC-L2, ARCH): at a dimension grain a
 * PY row on a member the budget cannot take (an inactive centre, a centre with NULL or the other
 * cc_type) counts as UNASSIGNED, so the `unassigned` rule decides it and nothing is written to
 * that member; a year label the registry has no year for is a 400 for PY actuals, and a copy
 * source whose own label the registry has no year for is a 404 (as the grid's other routes answer it), never a
 * 500; fiscalYear outside 1..9999 is refused by validation.
 * Expected figures are worked by hand in the comments. Real PostgreSQL through the real route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import seedRoute from '../../pages/api/accounting/budget-grid/seed';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo, type RouteOut } from './helpers/budgetGridFixture';
import { MAX_IMPORT_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
let C: GridCo;
let untyped: string;

const seed = (c: GridCo, b: unknown) => fx.call(seedRoute, '/api/accounting/budget-grid/seed', c.owner, 'POST', {}, b);
const body = (fiscalYear: number, name: string, source: Record<string, unknown>) =>
  ({ fiscalYear, name, kind: 'scenario', makePrimary: false, roundingUnit: 1, source });
const dump = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const versionOf = (r: RouteOut) => (r.body.data as { versionId: string }).versionId;
/** Non-zero rows as [account, month, amount, cc1]. */
const nonZero = async (versionId: string) => (await pool.query(
  `SELECT gl_account_id::text a, to_char(month, 'YYYY-MM') m, amount::text v, cc1_id::text c FROM budget_month_amounts
    WHERE version_id = $1 AND amount <> 0 ORDER BY 1, 2, 4`, [versionId])).rows.map((r) => [r.a, r.m, r.v, r.c]);
const cc1Used = async (versionId: string) => (await pool.query(
  'SELECT DISTINCT cc1_id::text c FROM budget_month_amounts WHERE version_id = $1 AND cc1_id IS NOT NULL ORDER BY 1', [versionId])).rows.map((r) => r.c);

beforeAll(async () => {
  C = await fx.company();
  untyped = String((await pool.query(
    `INSERT INTO cost_centres (company_id, code, name, cc_type, is_active) VALUES ($1, 'GNULL', 'Untyped', NULL, true) RETURNING id`, [C.id])).rows[0].id);
  // PY of FY2027 is Mar 2025 - Feb 2026. Sales Mar: 1000 on CC1 (active), 300 on the inactive CC1.
  await fx.journal(C, '2025-03-10', [{ acct: C.acct.sales, credit: 1000, cc1: C.cc1 }]);
  await fx.journal(C, '2025-03-11', [{ acct: C.acct.sales, credit: 300, cc1: C.cc1Inactive }]);
  // Rent Apr: 50, only on the inactive CC1. Cost of sales May: 70, only on the untyped centre.
  await fx.journal(C, '2025-04-10', [{ acct: C.acct.rent, debit: 50, cc1: C.cc1Inactive }]);
  await fx.journal(C, '2025-05-10', [{ acct: C.acct.cos, debit: 70, cc1: untyped }]);
  // Premises: rates Jun: 20 on the CC2 centre filed in the CC1 column.
  await fx.journal(C, '2025-06-10', [{ acct: C.acct.childA, debit: 20, cc1: C.cc2 }]);
}, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

describe('seed: PY at CC1 grain, members the budget cannot take', () => {
  it("unassigned 'company': every account with such a row is budgeted at company level, PY totals kept", async () => {
    const r = await seed(C, body(2027, 'R6-company', { type: 'py_actuals', upliftPct: 0, grain: 'cc1', unassigned: 'company' }));
    expect(r.status, dump(r)).toBe(200);
    const v = versionOf(r);
    // Sales 1000 + 300 -> one company row of 1300 (Mar); Rent 50 (Apr); Cost of sales 70 (May); rates 20 (Jun).
    expect(await nonZero(v)).toEqual([
      [C.acct.sales, '2026-03', '1300.00', null], [C.acct.cos, '2026-05', '70.00', null],
      [C.acct.rent, '2026-04', '50.00', null], [C.acct.childA, '2026-06', '20.00', null],
    ].sort((a, b) => (`${a[0]}${a[1]}` < `${b[0]}${b[1]}` ? -1 : 1)));
    expect(await cc1Used(v)).toEqual([]);
  });

  it("unassigned 'drop': only the active CC1 series survives", async () => {
    const r = await seed(C, body(2027, 'R6-drop', { type: 'py_actuals', upliftPct: 0, grain: 'cc1', unassigned: 'drop' }));
    expect(r.status, dump(r)).toBe(200);
    const v = versionOf(r);
    expect(await nonZero(v)).toEqual([[C.acct.sales, '2026-03', '1000.00', C.cc1]]);
    expect(await cc1Used(v)).toEqual([C.cc1]);
  });
});

describe('seed: size', () => {
  it(`a plan of more than MAX_IMPORT_CELLS (${MAX_IMPORT_CELLS}) cells is 400 before anything is written`, async () => {
    // 8 334 extra leaf expense accounts with no activity, seeded as zero rows: 8 334 x 12 > 100 000.
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       SELECT $1, 'GZ' || lpad(g::text, 5, '0'), 'Zero ' || g, 'expense', 'debit', 3, true FROM generate_series(1, 8334) g`, [C.id]);
    try {
      const r = await seed(C, { ...body(2027, 'S-too-big', { type: 'py_actuals', upliftPct: 0, grain: 'company' }), includeNoActivity: true });
      expect([r.status, r.body.error?.details?.code], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
      expect(String(r.body.error?.message)).toContain(String(MAX_IMPORT_CELLS));
      expect(Number((await pool.query('SELECT COUNT(*)::int n FROM budget_versions WHERE company_id = $1 AND name = $2', [C.id, 'S-too-big'])).rows[0].n)).toBe(0);
    } finally {
      await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'GZ%'`, [C.id]);
    }
  }, 120000);
});

describe('seed: size of a same-year exact copy', () => {
  it(`a 0% same-year copy of a source holding more than MAX_IMPORT_CELLS cells is 400 before anything is copied`, async () => {
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       SELECT $1, 'GY' || lpad(g::text, 5, '0'), 'Copy ' || g, 'expense', 'debit', 3, true FROM generate_series(1, 8334) g`, [C.id]);
    const src = await fx.version(C, { name: 'Y-big-src' });
    try {
      // 8 334 accounts x 12 months = 100 008 cells in the source.
      await pool.query(
        `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
         SELECT $1, $2, ga.id, (DATE '2026-03-01' + make_interval(months => m)), 1
           FROM gl_accounts ga CROSS JOIN generate_series(0, 11) m WHERE ga.company_id = $1 AND ga.account_code LIKE 'GY%'`, [C.id, src]);
      const r = await seed(C, body(2027, 'Y-big-copy', { type: 'version', versionId: src, upliftPct: 0 }));
      expect([r.status, r.body.error?.details?.code], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
      expect(String(r.body.error?.message)).toContain(String(MAX_IMPORT_CELLS));
      expect(Number((await pool.query('SELECT COUNT(*)::int n FROM budget_versions WHERE company_id = $1 AND name = $2', [C.id, 'Y-big-copy'])).rows[0].n)).toBe(0);
    } finally {
      await pool.query('DELETE FROM budget_versions WHERE id = $1', [src]);
      await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'GY%'`, [C.id]);
    }
  }, 180000);
});

describe('seed: years', () => {
  // Label 1 is a year no registry walk reaches (the registry gives up 500 years from a stored year).
  it('PY actuals for a label the registry has no year for is 400 naming it', async () => {
    const r = await seed(C, body(1, 'Y-unknown', { type: 'py_actuals', upliftPct: 0, grain: 'company' }));
    expect([r.status, r.body.error?.details?.code], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    expect(String(r.body.error?.message)).toContain('No financial year is labelled 1');
  });

  it('a copy from a version whose own year label the registry has no year for is 404, not 500', async () => {
    const stray = await fx.version(C, { fy: 1, name: 'Y-stray' });
    const r = await seed(C, body(2027, 'Y-from-stray', { type: 'version', versionId: stray, upliftPct: 5 }));
    expect(r.status, dump(r)).toBe(404);
    expect(Number((await pool.query('SELECT COUNT(*)::int n FROM budget_versions WHERE company_id = $1 AND name = $2', [C.id, 'Y-from-stray'])).rows[0].n)).toBe(0);
  });

  it('fiscalYear outside 1..9999 is refused by validation (422), never reaching the database', async () => {
    for (const fy of [0, -1, 10000, 2147483648]) {
      const r = await seed(C, body(fy, `Y-${fy}`, { type: 'blank' }));
      expect(r.status, `${fy}: ${dump(r)}`).toBe(422);
    }
  });
});
