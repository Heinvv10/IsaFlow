/**
 * Budgets P2 PR-B, the grid read model (spec 4.2 gridReadModel, 4.3 GET budget-grid, 6.5, 7.1):
 * primary / newest / named version, the account rule (active leaves + anything holding amounts,
 * inactive flagged), headers as roll-up rows with `ownAmounts`, band totals that count a legacy
 * header's own amounts once and never its roll-up, the microsecond text token, `cells_only`,
 * and tenant isolation (through the route under RLS and through the service on a superuser
 * connection, where only the query's own company_id protects).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { als } from '@/lib/als';
import { loadGridReadModel, type GridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const URL = '/api/accounting/budget-grid';
const get = (c: GridCo, query: Record<string, string>, who: 'owner' | 'viewer' = 'owner') => fx.call(gridRoute, URL, c[who], 'GET', query);
const data = <T,>(r: { body: { data?: unknown } }) => r.body.data as T;

const FY27 = monthsFrom('2026-03');
let A: GridCo, B: GridCo, T: GridCo;
let primary: string, draftScenario: string, lockedFy27: string, newestFy28: string;

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  T = await fx.company({ transition: true });
  const a = A.acct;

  primary = await fx.version(A, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
  await fx.amounts(A, primary, a.sales, FY27, 1000);
  await fx.amounts(A, primary, a.cos, FY27, 400);
  await fx.amounts(A, primary, a.rent, FY27, 100, { cc1: A.cc1 });
  await fx.amounts(A, primary, a.rent, FY27, 50, { cc1: A.cc1b });
  await fx.amounts(A, primary, a.childA, FY27, 30);
  await fx.amounts(A, primary, a.childB, FY27, 20);
  await fx.amount(A, primary, a.header, '2026-03', 7); // a legacy header budget
  await fx.amount(A, primary, a.inactive, '2026-03', 11); // inactive, but it holds an amount
  await fx.amount(A, primary, a.otherIncome, '2026-03', 40);
  await fx.amount(A, primary, a.bank, '2026-03', 999); // not revenue/expense: never listed
  await fx.amount(A, primary, a.sales, '2030-01', 5555); // outside the year's months: ignored
  draftScenario = await fx.version(A, { fy: 2027, name: 'Scenario', kind: 'scenario' });
  lockedFy27 = await fx.version(A, { fy: 2027, name: 'Locked copy', kind: 'reforecast', status: 'locked' });
  await fx.version(A, { fy: 2028, name: 'Older', kind: 'original' });
  newestFy28 = await fx.version(A, { fy: 2028, name: 'Newest', kind: 'scenario' });

  // Company B: the same fiscal years, its own versions and amounts.
  const bp = await fx.version(B, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
  await fx.amount(B, bp, B.acct.sales, '2026-03', 3);
  await fx.version(B, { fy: 2027, name: 'B scenario', kind: 'scenario' });
}, 120000);

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 60000);

/** The service on a superuser connection (no RLS), so only the query's own company_id isolates tenants. */
async function direct(c: GridCo, opts: { versionId?: string; fiscalYear?: number }): Promise<GridReadModel> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, companyId: c.id, userId: c.user, claims: {} } as never, () => loadGridReadModel(c.id, opts));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('budget-grid read model: which version', () => {
  it('?fiscal_year= answers the primary version, with the year and its twelve months', async () => {
    const r = await get(A, { fiscal_year: '2027' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const m = data<GridReadModel>(r);
    expect(m.version?.id).toBe(primary);
    expect(m.year.fiscalYear).toBe(2027);
    expect(m.year.monthKeys).toEqual(FY27);
  });

  it('?version_id= beats the primary, whatever its status (a locked version is readable)', async () => {
    expect(data<GridReadModel>(await get(A, { version_id: draftScenario })).version?.id).toBe(draftScenario);
    const locked = data<GridReadModel>(await get(A, { version_id: lockedFy27 }));
    expect(locked.version?.id).toBe(lockedFy27);
    expect(locked.version?.status).toBe('locked');
  });

  it('a year with no primary answers its newest version', async () => {
    expect(data<GridReadModel>(await get(A, { fiscal_year: '2028' })).version?.id).toBe(newestFy28);
  });

  it('a year with no version answers version null with the year, so the page can offer the wizard', async () => {
    const m = data<GridReadModel>(await get(A, { fiscal_year: '2026' }));
    expect(m.version).toBeNull();
    expect(m.updatedAt).toBeNull();
    expect(m.cells).toEqual([]);
    expect(m.year.monthKeys).toEqual(monthsFrom('2025-03'));
  });

  it('a 14-month transition year has fourteen months', async () => {
    const m = data<GridReadModel>(await get(T, { fiscal_year: '2027' }));
    expect(m.year.kind).toBe('transition');
    expect(m.year.monthKeys).toEqual(monthsFrom('2026-01', 14));
  });

  it('refuses bad input: no selector, a bad id, a bad year, a label no year carries', async () => {
    expect((await get(A, {})).status).toBe(400);
    expect((await get(A, { version_id: 'not-a-uuid' })).status).toBe(400);
    expect((await get(A, { fiscal_year: 'twenty' })).status).toBe(400);
    expect((await get(A, { fiscal_year: '1' })).status).toBe(404);
  });

  it('a viewer may read', async () => {
    expect((await get(A, { fiscal_year: '2027' }, 'viewer')).status).toBe(200);
  });
});

describe('budget-grid read model: the token', () => {
  it('updatedAt is P1\'s text form of the version row\'s updated_at, to the microsecond, and not a Date', async () => {
    // A microsecond tail a JS Date would drop (that would 409 every save). The updated_at trigger is skipped for this write.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE budget_versions SET updated_at = '2026-10-26 18:01:02.123457+00' WHERE id = $1", [draftScenario]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const text = (await pool.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM budget_versions WHERE id = $1`, [draftScenario])).rows[0].t as string;
    const m = data<GridReadModel>(await get(A, { version_id: draftScenario }));
    expect(typeof m.updatedAt).toBe('string');
    expect(m.updatedAt).toBe(text);
    expect(m.updatedAt).toBe('2026-10-26T18:01:02.123457Z');
    expect(m.updatedAt).toBe(m.version?.updatedAt);
    const cellsOnly = data<{ updatedAt: string }>(await get(A, { version_id: draftScenario, cells_only: '1' }));
    expect(cellsOnly.updatedAt).toBe(text);
  });
});

describe('budget-grid read model: accounts', () => {
  let m: GridReadModel;
  const byId = (id: string) => m.accounts.find((x) => x.id === id);
  beforeAll(async () => {
    m = data<GridReadModel>(await get(A, { version_id: primary }));
  });

  it('lists active leaves and anything holding amounts; never an asset, an inactive account with nothing, or a header with nothing under it', () => {
    const ids = new Set(m.accounts.map((x) => x.id));
    for (const k of ['sales', 'otherIncome', 'cos', 'rent', 'childA', 'childB', 'header', 'inactive'] as const) expect(ids.has(A.acct[k]), k).toBe(true);
    for (const k of ['bank', 'inactiveChild', 'inactiveHeader'] as const) expect(ids.has(A.acct[k]), k).toBe(false);
  });

  it('flags an inactive account that holds amounts, and gives each account its band', () => {
    expect(byId(A.acct.inactive)?.isActive).toBe(false);
    expect(byId(A.acct.sales)?.isActive).toBe(true);
    expect(byId(A.acct.sales)?.band).toBe('turnover');
    expect(byId(A.acct.otherIncome)?.band).toBe('other_income');
    expect(byId(A.acct.cos)?.band).toBe('cost_of_sales');
    expect(byId(A.acct.rent)?.band).toBe('operating_expense');
  });

  it('a header is a roll-up row: its children, the sum of them per month, and ownAmounts because it holds its own R7', () => {
    const h = byId(A.acct.header)!;
    expect(h.isHeader).toBe(true);
    expect(h.childIds.slice().sort()).toEqual([A.acct.childA, A.acct.childB].sort());
    expect(h.ownAmounts).toBe(true);
    expect(h.rollup).toEqual(FY27.map(() => 50));
    expect(byId(A.acct.childA)?.parentId).toBe(A.acct.header);
    expect(byId(A.acct.childA)?.depth).toBe(1);
    expect(byId(A.acct.header)?.depth).toBe(0);
  });

  it('children follow their header in the list', () => {
    const order = m.accounts.map((x) => x.id);
    const at = order.indexOf(A.acct.header);
    expect(order.slice(at + 1, at + 3).sort()).toEqual([A.acct.childA, A.acct.childB].sort());
  });

  it('ownAmounts is set only on a header that holds amounts', () => {
    expect(m.accounts.filter((x) => x.ownAmounts).map((x) => x.id)).toEqual([A.acct.header]);
    expect(byId(A.acct.sales)?.ownAmounts).toBe(false);
    expect(byId(A.acct.sales)?.isHeader).toBe(false);
  });

  it('a header with no amounts of its own has ownAmounts false (the scenario has none)', async () => {
    const s = data<GridReadModel>(await get(A, { version_id: draftScenario }));
    const h = s.accounts.find((x) => x.id === A.acct.header)!;
    expect(h.ownAmounts).toBe(false);
    expect(s.accounts.some((x) => x.id === A.acct.inactive)).toBe(false);
  });

  it('grains come from the amounts: rent by CC1, sales at company level, an account with none has none', () => {
    expect(m.grains[A.acct.rent]).toBe('cc1');
    expect(m.grains[A.acct.sales]).toBe('company');
    expect(m.grains[A.acct.childA]).toBe('company');
    expect(m.grains[A.acct.cos]).toBe('company');
    expect(byId(A.acct.rent)?.grain).toBe('cc1');
    expect(byId(A.acct.sales)?.grain).toBe('company');
  });

  it('dimension members: active ones, plus an inactive one only when the version uses it', async () => {
    expect(m.dimensions.cc1.map((x) => x.id).sort()).toEqual([A.cc1, A.cc1b].sort());
    expect(m.dimensions.cc2.map((x) => x.id)).toEqual([A.cc2]);
    expect(m.dimensions.bu.map((x) => x.id)).toEqual([A.bu]);
    expect(m.dimensions.cc1[0]).toMatchObject({ code: expect.any(String), name: expect.any(String), isActive: true });
    await fx.amount(A, draftScenario, A.acct.rent, '2026-03', 5, { cc1: A.cc1Inactive });
    const s = data<GridReadModel>(await get(A, { version_id: draftScenario }));
    expect(s.dimensions.cc1.find((x) => x.id === A.cc1Inactive)).toMatchObject({ isActive: false });
    await pool.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [draftScenario]);
  });
});

describe('budget-grid read model: cells and totals', () => {
  let m: GridReadModel;
  beforeAll(async () => {
    m = data<GridReadModel>(await get(A, { version_id: primary }));
  });

  it('cells carry the account, the dimension, the YYYY-MM month and a numeric amount; nothing outside the year or off the P&L', () => {
    // sales 12, cos 12, rent 24 (two CC1 members), childA 12, childB 12, header 1, inactive 1, other income 1
    expect(m.cells.length).toBe(75);
    const rent = m.cells.filter((c) => c.glAccountId === A.acct.rent && c.month === '2026-03');
    expect(rent.map((c) => [c.cc1Id, c.amount]).sort()).toEqual([[A.cc1, 100], [A.cc1b, 50]].sort());
    expect(m.cells.every((c) => typeof c.amount === 'number' && /^\d{4}-\d{2}$/.test(c.month))).toBe(true);
    expect(m.cells.some((c) => c.glAccountId === A.acct.bank)).toBe(false);
    expect(m.cells.some((c) => c.month === '2030-01')).toBe(false);
  });

  it('keeps the exact cents', async () => {
    const v = await fx.version(A, { fy: 2027, name: 'Cents' });
    await fx.amount(A, v, A.acct.sales, '2026-03', 1234567.89);
    const c = data<GridReadModel>(await get(A, { version_id: v })).cells;
    expect(c).toEqual([{ glAccountId: A.acct.sales, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1234567.89 }]);
    await pool.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [v]);
    await pool.query('DELETE FROM budget_versions WHERE id = $1', [v]);
  });

  it('band totals: a company roll-up of the dimension rows, a legacy header\'s own R7 once, and never the header\'s roll-up', () => {
    // March operating expenses: rent 100+50, childA 30, childB 20, header own 7, inactive 11 = 218. Adding the
    // header's roll-up (50) would give 268.
    expect(m.totals.months.operatingExpenses[0]).toBe(218);
    expect(m.totals.months.operatingExpenses[1]).toBe(200);
    expect(m.totals.fy.turnover).toBe(12000);
    expect(m.totals.fy.costOfSales).toBe(4800);
    expect(m.totals.fy.grossProfit).toBe(7200);
    expect(m.totals.fy.otherIncome).toBe(40);
    expect(m.totals.fy.operatingExpenses).toBe(200 * 12 + 18);
    expect(m.totals.fy.operatingProfit).toBe(7200 + 40 - (200 * 12 + 18));
    expect(m.totals.fy.netProfit).toBe(m.totals.fy.operatingProfit);
  });

  it('cells_only answers just the cells and the token (the compare-version fetch)', async () => {
    const r = await get(A, { version_id: primary, cells_only: '1' });
    expect(r.status).toBe(200);
    const body = data<Record<string, unknown>>(r);
    expect(Object.keys(body).sort()).toEqual(['cells', 'updatedAt', 'versionId']);
    expect(body.versionId).toBe(primary);
    expect(body.cells).toEqual(m.cells);
    expect(body.updatedAt).toBe(m.updatedAt);
  });
});

describe('budget-grid read model: tenant isolation', () => {
  it('another tenant\'s version id is a 404, and the same year answers only the caller\'s own figures', async () => {
    const r = await get(B, { version_id: primary });
    expect(r.status).toBe(404);
    expect(r.body.error?.details?.code).toBe('BUDGET_VERSION_NOT_FOUND');
    const own = data<GridReadModel>(await get(B, { fiscal_year: '2027' }));
    expect(own.cells.map((c) => c.amount)).toEqual([3]);
    expect(own.accounts.every((x) => Object.values(B.acct).includes(x.id))).toBe(true);
  });

  it('the service alone (no RLS) lists only the caller\'s accounts, members and cells', async () => {
    const m = await direct(B, { fiscalYear: 2027 });
    expect(m.cells.map((c) => c.glAccountId)).toEqual([B.acct.sales]);
    expect(m.accounts.every((x) => Object.values(B.acct).includes(x.id))).toBe(true);
    expect(m.accounts.length).toBeGreaterThan(0);
    const members = [...m.dimensions.cc1, ...m.dimensions.cc2, ...m.dimensions.bu].map((x) => x.id);
    expect(members.every((id) => [B.cc1, B.cc1b, B.cc2, B.bu].includes(id))).toBe(true);
    expect(m.totals.fy.turnover).toBe(3);
  });

  it('the newest-version fallback never reaches another tenant\'s versions', async () => {
    // A has FY2028 versions and no primary; B has none: B must see no version, not A's newest.
    const m = await direct(B, { fiscalYear: 2028 });
    expect(m.version).toBeNull();
    expect(m.cells).toEqual([]);
  });

  it('the service refuses another tenant\'s version id', async () => {
    await expect(direct(B, { versionId: primary })).rejects.toMatchObject({ code: 'BUDGET_VERSION_NOT_FOUND' });
  });
});
