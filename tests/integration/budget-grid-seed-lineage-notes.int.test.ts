/**
 * Budgets P2 follow-ups through the create wizard (POST /api/accounting/budget-grid/seed, real
 * members, withAuth's request transaction):
 *
 * F2, lineage (decision D2): every version made from another version records
 * `based_on_version_id` = that source, exact copy or uplift, same year or another; PY-actuals and
 * blank seeds have no source (null). Read back from the column and from GET
 * /api/accounting/budget-versions/[id] (`basedOnVersionId`).
 *
 * F1, carry (decision D5): a seed into another year copies the source year's notes
 * (`accounting_budgets.notes`, year-scoped) for the seeded leaf accounts, only where the target
 * year has no non-blank note; the source year is the source version's for a version seed and the
 * prior year for PY actuals; a blank seed carries nothing; a refused seed carries nothing (the
 * seed's savepoint), including a refusal after the carry (an admin making a version primary over a
 * locked primary).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import seedRoute from '../../pages/api/accounting/budget-grid/seed';
import oneRoute from '../../pages/api/accounting/budget-versions/[id]/index';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import { als } from '@/lib/als';
import { carryNotes } from '@/modules/accounting/services/budgets/budgetNotes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const URL = '/api/accounting/budget-grid/seed';

let A: GridCo, C: GridCo;
let admin: SetupUser;
let src27: string;

type Source = Record<string, unknown>;
const body = (fiscalYear: number, name: string, source: Source, extra: Record<string, unknown> = {}) =>
  ({ fiscalYear, name, kind: 'scenario', makePrimary: false, roundingUnit: 1, source, ...extra });
const seed = (c: GridCo, b: unknown, u: SetupUser = c.owner) => fx.call(seedRoute, URL, u, 'POST', {}, b);
const idOf = (r: { body: { data?: unknown } }) => (r.body.data as { versionId: string }).versionId;
const dump = (r: { status: number; body: unknown }) => JSON.stringify(r.body).slice(0, 300);
const basedOn = async (id: string) => (await pool.query('SELECT based_on_version_id FROM budget_versions WHERE id = $1', [id])).rows[0].based_on_version_id as string | null;
const apiBasedOn = async (c: GridCo, id: string) => {
  const r = await fx.call(oneRoute, '/api/accounting/budget-versions/[id]', c.owner, 'GET', { id });
  expect(r.status, dump(r)).toBe(200);
  return (r.body.data as { basedOnVersionId: string | null }).basedOnVersionId;
};
const note = (c: GridCo, acct: string, fy: number, text: string | null) => pool.query(
  `INSERT INTO accounting_budgets (company_id, gl_account_id, fiscal_year, budget_name, notes) VALUES ($1, $2, $3, 'Notes', $4)
   ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL DO UPDATE SET notes = EXCLUDED.notes`, [c.id, acct, fy, text]);
const notesOf = async (c: GridCo, fy: number) => Object.fromEntries((await pool.query(
  `SELECT gl_account_id, notes FROM accounting_budgets WHERE company_id = $1 AND fiscal_year = $2`, [c.id, fy])).rows.map((r) => [r.gl_account_id, r.notes]));
const clearYear = (c: GridCo, fy: number) => pool.query('DELETE FROM accounting_budgets WHERE company_id = $1 AND fiscal_year = $2', [c.id, fy]);

beforeAll(async () => {
  A = await fx.company();
  C = await fx.company();
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)`, [C.id, userId]);
  admin = { userId, homeCompanyId: C.id, token: await signSession(userId, undefined, 'aal2') };

  // A's FY2027 source: sales, rent, a header's own amount and an inactive account's amount.
  src27 = await fx.version(A, { fy: 2027, name: 'SRC27' });
  await fx.amount(A, src27, A.acct.sales, '2026-03', 100);
  await fx.amount(A, src27, A.acct.rent, '2026-04', 50);
  await fx.amount(A, src27, A.acct.header, '2026-03', 7);
  await fx.amount(A, src27, A.acct.inactive, '2026-03', 9);
  // PY activity (FY2026 = Mar 2025 - Feb 2026) on sales and rent.
  await fx.journal(A, '2025-05-10', [{ acct: A.acct.sales, credit: 500 }]);
  await fx.journal(A, '2025-06-10', [{ acct: A.acct.rent, debit: 80 }]);
}, 120000);

afterAll(async () => {
  try {
    await fx.cleanup();
    await pool.query('DELETE FROM users WHERE id = $1', [admin.userId]);
  } finally {
    await pool.end();
  }
}, 60000);

describe('F2: based_on_version_id on every version-sourced seed', () => {
  it('same year 0% (the exact copy), same year +5%, another year 0% and +10%: all record the source', async () => {
    const cases = [
      body(2027, 'L-SAME-0', { type: 'version', versionId: src27, upliftPct: 0 }),
      body(2027, 'L-SAME-5', { type: 'version', versionId: src27, upliftPct: 5 }),
      body(2028, 'L-NEXT-0', { type: 'version', versionId: src27, upliftPct: 0 }),
      body(2028, 'L-NEXT-10', { type: 'version', versionId: src27, upliftPct: 10 }),
    ];
    for (const b of cases) {
      const r = await seed(A, b);
      expect(r.status, `${b.name} ${dump(r)}`).toBe(200);
      expect(await basedOn(idOf(r)), b.name).toBe(src27);
      expect(await apiBasedOn(A, idOf(r)), b.name).toBe(src27);
    }
  });

  it('PY actuals and blank seeds have no source: null', async () => {
    for (const b of [body(2027, 'L-PY', { type: 'py_actuals', upliftPct: 0, grain: 'company' }), body(2027, 'L-BLANK', { type: 'blank' })]) {
      const r = await seed(A, b);
      expect(r.status, `${b.name} ${dump(r)}`).toBe(200);
      expect(await basedOn(idOf(r)), b.name).toBeNull();
      expect(await apiBasedOn(A, idOf(r)), b.name).toBeNull();
    }
  });
});

describe('F1: notes carried by a seed into another year', () => {
  it('a version seed into FY2028 carries FY2027\'s notes of the seeded leaf accounts; never a header\'s, an inactive\'s or an unseeded account\'s', async () => {
    await clearYear(A, 2028);
    await note(A, A.acct.sales, 2027, 'Sales: new price list');
    await note(A, A.acct.rent, 2027, 'Rent: lease from March');
    await note(A, A.acct.header, 2027, 'Header note');
    await note(A, A.acct.inactive, 2027, 'Inactive note');
    await note(A, A.acct.cos, 2027, 'COS: not in the source');
    await note(C, A.acct.childA, 2027, 'Another tenant, on an id A does not seed'); // never read for A
    await note(C, A.acct.sales, 2026, 'Another tenant, on A\'s account id'); // a year A does not carry from here
    const r = await seed(A, body(2028, 'C-NEXT', { type: 'version', versionId: src27, upliftPct: 3 }));
    expect(r.status, dump(r)).toBe(200);
    expect(await notesOf(A, 2028)).toEqual({ [A.acct.sales]: 'Sales: new price list', [A.acct.rent]: 'Rent: lease from March' });
    const row = (await pool.query(
      `SELECT budget_name, period_amounts, total_amount::text t, annual_amount::text a FROM accounting_budgets WHERE company_id = $1 AND fiscal_year = 2028 AND gl_account_id = $2`,
      [A.id, A.acct.sales])).rows[0];
    expect(row).toEqual({ budget_name: 'Notes', period_amounts: {}, t: '0.00', a: '0.00' });
  });

  it('never overwrites the target year\'s note; a blank target note is filled', async () => {
    await clearYear(A, 2028);
    await note(A, A.acct.sales, 2028, 'Kept: FY28 own note');
    await note(A, A.acct.rent, 2028, '  ');
    const r = await seed(A, body(2028, 'C-KEEP', { type: 'version', versionId: src27, upliftPct: 0 }));
    expect(r.status, dump(r)).toBe(200);
    expect(await notesOf(A, 2028)).toEqual({ [A.acct.sales]: 'Kept: FY28 own note', [A.acct.rent]: 'Rent: lease from March' });
  });

  it('a PY-actuals seed carries the prior year\'s notes of the accounts it seeds', async () => {
    await clearYear(A, 2027);
    await note(A, A.acct.sales, 2026, 'FY26 sales note');
    await note(A, A.acct.cos, 2026, 'FY26 COS note: no PY activity, not seeded');
    const r = await seed(A, body(2027, 'C-PY', { type: 'py_actuals', upliftPct: 0, grain: 'company' }));
    expect(r.status, dump(r)).toBe(200);
    expect(await notesOf(A, 2027)).toEqual({ [A.acct.sales]: 'FY26 sales note' });
    // C's FY2026 row on A's sales id is C's: never carried into A, never written into C.
    expect(await notesOf(C, 2027)).toEqual({ [A.acct.childA]: 'Another tenant, on an id A does not seed' });
  });

  it('a same-year copy and a blank seed write no note rows', async () => {
    await clearYear(A, 2027);
    await clearYear(A, 2028);
    await note(A, A.acct.sales, 2027, 'Shared by the year');
    const same = await seed(A, body(2027, 'C-SAME', { type: 'version', versionId: src27, upliftPct: 5 }));
    expect(same.status, dump(same)).toBe(200);
    const blank = await seed(A, body(2028, 'C-BLANK', { type: 'blank' }));
    expect(blank.status, dump(blank)).toBe(200);
    expect(await notesOf(A, 2027)).toEqual({ [A.acct.sales]: 'Shared by the year' });
    expect(await notesOf(A, 2028)).toEqual({});
  });

  it('a refused seed carries nothing: a name clash, and an admin\'s make-primary over a locked primary (refused after the carry)', async () => {
    await clearYear(A, 2028);
    const clash = await seed(A, body(2028, 'C-NEXT', { type: 'version', versionId: src27, upliftPct: 0 }));
    expect(clash.status, dump(clash)).toBe(409);
    expect(await notesOf(A, 2028)).toEqual({});

    const cSrc = await fx.version(C, { fy: 2027, name: 'C-SRC' });
    await fx.amount(C, cSrc, C.acct.sales, '2026-03', 10);
    await note(C, C.acct.sales, 2027, 'C sales note');
    await fx.version(C, { fy: 2028, name: 'C-LOCKED-PRIMARY', kind: 'original', status: 'locked', primary: true });
    const r = await seed(C, body(2028, 'C-ADMIN-PRIMARY', { type: 'version', versionId: cSrc, upliftPct: 0 }, { makePrimary: true }), admin);
    expect(r.status, dump(r)).toBe(403);
    expect(await notesOf(C, 2028)).toEqual({});
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM budget_versions WHERE company_id = $1 AND name = 'C-ADMIN-PRIMARY'`, [C.id])).rows[0].n)).toBe(0);
  });
});

describe('carryNotes (service, superuser connection: no RLS)', () => {
  it('reads and writes only the caller\'s company: another tenant\'s row on the same account id and year is neither carried nor written', async () => {
    await clearYear(A, 2026);
    await clearYear(A, 2027);
    await clearYear(C, 2027);
    await note(A, A.acct.rent, 2026, 'A rent FY26');
    await note(C, A.acct.sales, 2026, 'C row on A\'s sales id');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const n = await als.run({ client, companyId: A.id, userId: A.user, claims: {} } as never,
        () => carryNotes(A.id, A.user, 2026, 2027, [A.acct.sales, A.acct.rent]));
      expect(n).toBe(1);
      const rows = (await client.query(
        `SELECT company_id, gl_account_id, notes FROM accounting_budgets WHERE company_id = ANY($1) AND fiscal_year = 2027`, [[A.id, C.id]])).rows;
      expect(rows).toEqual([{ company_id: A.id, gl_account_id: A.acct.rent, notes: 'A rent FY26' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
