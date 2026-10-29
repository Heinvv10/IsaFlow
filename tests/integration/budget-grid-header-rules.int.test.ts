/**
 * Decision 18 (spec §6.5): budgets go on leaf accounts. A NEW budget on a header (any account
 * another account names as its parent, active or not) or on an inactive account is refused with a
 * 400 naming the account, nothing written, by the grid save (the legacy writer, upsertBudget, and
 * the year copy were removed in budgets P2 PR-D with the old page's routes). An
 * account that already holds amounts in the version is exempt: a legacy header budget can be
 * edited, moved to a sub-account or spread across them, each in one batch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, errCode, errMessage, type GridWorld } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

type Cell = { glAccountId: string; cc1Id: null; cc2Id: null; buId: null; month: string; amount: number | null; clear?: true };
const cell = (glAccountId: string, month: string, amount: number | null): Cell =>
  ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true as const } : {}) });
const save = async (versionId: string, cells: Cell[]) =>
  fx.call(w.u, { versionId, expectedUpdatedAt: await fx.token(versionId), cells });
const k = (acct: string, month: string, amount: string) => `${acct}||||${month}=${amount}`;
const dump = (r: { body: unknown }) => JSON.stringify(r.body).slice(0, 300);

async function refusedUnchanged(versionId: string, cells: Cell[], code: string) {
  const before = { cells: await fx.cells(versionId), token: await fx.token(versionId) };
  const r = await save(versionId, cells);
  expect([r.status, errCode(r)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
  expect(errMessage(r)).toContain(code);
  expect({ cells: await fx.cells(versionId), token: await fx.token(versionId) }).toEqual(before);
}

describe('decision 18 through the grid save', () => {
  it('a new cell on a header, on a header whose only child is inactive, or on an inactive account is 400 naming it', async () => {
    const v = await fx.version(w);
    const m = w.months[0]!;
    await refusedUnchanged(v, [cell(w.child1, m, 1), cell(w.header, m, 10)], 'GS-6000');
    await refusedUnchanged(v, [cell(w.header2, m, 10)], 'GS-7000');
    await refusedUnchanged(v, [cell(w.inactive, m, 10)], 'GS-6900');
  });

  it("amounts the header holds in ANOTHER version do not exempt it", async () => {
    const elsewhere = await fx.version(w);
    await fx.amount(w, elsewhere, w.header, w.months[0]!, 50);
    const v = await fx.version(w);
    await refusedUnchanged(v, [cell(w.header, w.months[1]!, 10)], 'GS-6000');
  });

  it('a header that already holds amounts can be edited, including a month it did not hold', async () => {
    const v = await fx.version(w);
    const [m0, m1] = w.months;
    await fx.amount(w, v, w.header, m0!, 100);
    const r = await save(v, [cell(w.header, m0!, 120), cell(w.header, m1!, 30)]);
    expect(r.status, dump(r)).toBe(200);
    expect(await fx.cells(v)).toEqual([k(w.header, m0!, '120.00'), k(w.header, m1!, '30.00')].sort());
  });

  it("a header's own amounts move to a sub-account in one batch", async () => {
    const v = await fx.version(w);
    const [m0, m1] = w.months;
    await fx.amount(w, v, w.header, m0!, 100);
    await fx.amount(w, v, w.header, m1!, 200);
    const r = await save(v, [cell(w.header, m0!, null), cell(w.header, m1!, null), cell(w.child1, m0!, 100), cell(w.child1, m1!, 200)]);
    expect(r.status, dump(r)).toBe(200);
    expect(await fx.cells(v)).toEqual([k(w.child1, m0!, '100.00'), k(w.child1, m1!, '200.00')].sort());
  });

  it("a header's own amounts spread across its sub-accounts in one batch", async () => {
    const v = await fx.version(w);
    const m0 = w.months[0]!;
    await fx.amount(w, v, w.header, m0, 300.01);
    const r = await save(v, [cell(w.header, m0, null), cell(w.child1, m0, 150), cell(w.child2, m0, 150.01)]);
    expect(r.status, dump(r)).toBe(200);
    expect(await fx.cells(v)).toEqual([k(w.child1, m0, '150.00'), k(w.child2, m0, '150.01')].sort());
  });

  it('an inactive account that holds amounts stays editable', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.inactive, w.months[0]!, 10);
    const r = await save(v, [cell(w.inactive, w.months[0]!, 11)]);
    expect(r.status, dump(r)).toBe(200);
  });
});
