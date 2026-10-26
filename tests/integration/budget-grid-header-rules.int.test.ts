/**
 * Decision 18 (spec §6.5): budgets go on leaf accounts. A NEW budget on a header (any account
 * another account names as its parent, active or not) or on an inactive account is refused with a
 * 400 naming the account, nothing written, by the grid save AND by the legacy writer
 * (core/budgetService.upsertBudget, behind POST /api/accounting/budgets and the MCP tools). An
 * account that already holds amounts in the version is exempt: a legacy header budget can be
 * edited, moved to a sub-account or spread across them, each in one batch. The legacy writer
 * checks AFTER it locks the version, in a savepoint (round-1 BRK-L1): a header's amounts deleted
 * by a save that commits while the legacy write waits do not exempt it, and a refusal keeps
 * neither the token bump nor a primary created for the write.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type RawSql = ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) & Record<string, unknown>;
const hooks = vi.hoisted(() => ({ match: null as null | RegExp, fn: null as null | (() => Promise<void>), fired: 0 }));

// Every statement runs on the real database; once armed, `fn` runs right after the first statement matching `match`.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RawSql;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { match, fn } = hooks;
    if (!match || !fn || !match.test(strings.join('?'))) return realSql(strings, ...values);
    return (async () => {
      hooks.match = null;
      hooks.fn = null;
      hooks.fired += 1;
      const rows = await realSql(strings, ...values);
      await fn();
      return rows;
    })();
  };
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import saveRoute from '../../pages/api/accounting/budget-grid/save';
import budgetsRoute from '../../pages/api/accounting/budgets';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { budgetGridSaveFixture, errCode, errMessage, type GridWorld } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
const legacy = budgetsRouteFixture(pool, budgetsRoute, '/api/accounting/budgets');

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

describe('decision 18 through the legacy writer (upsertBudget, POST /api/accounting/budgets)', () => {
  const primaries = async () => Number((await pool.query(
    'SELECT COUNT(*)::int n FROM budget_versions WHERE company_id = $1 AND is_primary', [w.u.homeCompanyId])).rows[0].n);
  const headerRows = async () => Number((await pool.query(
    'SELECT COUNT(*)::int n FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = ANY($2)',
    [w.u.homeCompanyId, [w.header, w.header2, w.inactive]])).rows[0].n);

  it('a new budget on a header or an inactive account is 400 naming it; no version or amount is created', async () => {
    expect(await primaries()).toBe(0);
    const rowsBefore = await headerRows();
    for (const [acct, code] of [[w.header, 'GS-6000'], [w.header2, 'GS-7000'], [w.inactive, 'GS-6900']] as const) {
      const r = await legacy.call(w.u, 'POST', { glAccountId: acct, fiscalYear: w.label, annualAmount: 1200 });
      expect(r.status, dump(r)).toBe(400);
      expect(String(r.body.error?.message)).toContain(code);
    }
    expect(await primaries()).toBe(0);
    expect(await headerRows()).toBe(rowsBefore);
  });

  it('a header that holds amounts in the primary can still be saved through the legacy route', async () => {
    const prim = await fx.version(w, { primary: true, name: 'Original' });
    await fx.amount(w, prim, w.header, w.months[0]!, 100);
    const r = await legacy.call(w.u, 'POST', { glAccountId: w.header, fiscalYear: w.label, annualAmount: 1200 });
    expect(r.status, dump(r)).toBe(200);
    const sum = (await pool.query('SELECT SUM(amount)::text s FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2',
      [prim, w.header])).rows[0].s;
    expect(sum).toBe('1200.00');
    // A leaf still saves as before.
    expect((await legacy.call(w.u, 'POST', { glAccountId: w.child1, fiscalYear: w.label, annualAmount: 600 })).status).toBe(200);
  });

  it('a header whose amounts a concurrent save deletes, before the legacy write takes the version, is refused (checked after the lock)', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.header, w.months[0]!, 7);
    let concurrent = 0;
    hooks.fired = 0;
    // writeVersion's first read of the named version: the legacy write has not locked it yet.
    hooks.match = /SELECT fiscal_year FROM budget_versions WHERE id = \?::UUID AND company_id = \?::UUID/;
    hooks.fn = async () => { concurrent = (await save(v, [cell(w.header, w.months[0]!, null)])).status; };
    const r = await legacy.call(w.u, 'POST', { glAccountId: w.header, fiscalYear: w.label, annualAmount: 1200, versionId: v });
    expect([hooks.fired, concurrent]).toEqual([1, 200]);
    expect(r.status, dump(r)).toBe(400);
    expect(String(r.body.error?.message)).toContain('GS-6000');
    expect(await fx.cells(v)).toEqual([]);
  });

  it('a refusal after the version lock keeps neither the token bump nor the write (named version, grain clash too)', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.sales, w.months[0]!, 9, { cc1: w.cc1 });
    for (const [acct, code] of [[w.header, 'GS-6000'], [w.inactive, 'GS-6900'], [w.sales, 'GS-4000']] as const) {
      const before = { cells: await fx.cells(v), token: await fx.token(v), audits: (await fx.audits(v)).length };
      const r = await legacy.call(w.u, 'POST', { glAccountId: acct, fiscalYear: w.label, annualAmount: 1200, versionId: v });
      expect(r.status, dump(r)).toBe(400);
      expect(String(r.body.error?.message)).toContain(code);
      expect({ cells: await fx.cells(v), token: await fx.token(v), audits: (await fx.audits(v)).length }).toEqual(before);
    }
  });
});
