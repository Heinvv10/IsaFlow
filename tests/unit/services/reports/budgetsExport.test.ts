/**
 * budget_versions / budgets export tables (FibreFlow contract isaflow-budgets-1.0).
 *
 * Pure part (budgetsExportRows): column order, the version row's fields, the
 * per-head roll-up (D7, salary privacy: an account with ANY per_head driver
 * line in a version leaves only company-level rows, one per month, summing
 * every cell of it), the deterministic sort and the control total in integer
 * cents. Async part (budgetsExport): which services are read, per version, and
 * that only per_head lines trigger the roll-up. The real database (every
 * version, the variance tie, the tenant boundary) is
 * tests/integration/budgets-export.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const svc = vi.hoisted(() => ({ list: vi.fn(), cells: vi.fn(), drivers: vi.fn(), chart: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ listVersions: svc.list }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridCells: svc.cells }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', () => ({ listDriverLines: svc.drivers }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', () => ({ loadChartRefs: svc.chart }));

import {
  BUDGETS_COLUMNS, BUDGETS_SCHEMA_VERSION, BUDGET_VERSIONS_COLUMNS, budgetRows, budgetVersionRows, budgetsSummary,
} from '@/modules/accounting/services/reports/budgetsExportRows';
import { buildBudgetVersions, buildBudgets } from '@/modules/accounting/services/reports/budgetsExport';
import type { GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';

const V1 = '11111111-0000-4000-8000-000000000001';
const V2 = '22222222-0000-4000-8000-000000000002';
const SALES = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WAGES = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RENT = 'cccccccc-0000-4000-8000-00000000000c';
const CC_A = 'dddddddd-0000-4000-8000-00000000000d';
const CC_B = 'eeeeeeee-0000-4000-8000-00000000000e';
const CODES = new Map([[SALES, '4000'], [WAGES, '6200'], [RENT, '6100']]);

const cell = (glAccountId: string, month: string, amount: number, dims: Partial<GridCell> = {}, source: GridCell['source'] = 'manual'): GridCell => ({
  glAccountId, month, amount, source, cc1Id: null, cc2Id: null, buId: null, ...dims,
});

const cents = (n: unknown) => Math.round(Number(n) * 100);
const sumCents = (rows: Array<Record<string, unknown>>) => rows.reduce((s, r) => s + cents(r.Amount), 0);

// V1: wages carries a per_head line, at CC1 grain, with a driver cell, an override and a manual one.
const V1_CELLS: GridCell[] = [
  cell(SALES, '2026-03', 1000.1),
  cell(SALES, '2026-04', -0.3),
  cell(WAGES, '2026-03', 500.01, { cc1Id: CC_A }, 'driver'),
  cell(WAGES, '2026-03', 300.02, { cc1Id: CC_B }, 'override'),
  cell(WAGES, '2026-04', 0.1, { cc1Id: CC_A }, 'driver'),
  cell(WAGES, '2026-04', 0.2, { cc1Id: CC_B }, 'manual'),
  cell(RENT, '2026-03', 250.05, { cc1Id: CC_B }),
  cell(RENT, '2026-03', 249.95, { cc1Id: CC_A }),
];

describe('budgetRows: per-head roll-up (D7)', () => {
  const rows = budgetRows([{ versionId: V1, cells: V1_CELLS, perHeadAccountIds: new Set([WAGES]) }], CODES);
  const wages = rows.filter((r) => r.GL_Account_ID === WAGES);

  it('a per_head account leaves ONLY company-level rows, one per month, Source per_head_rollup', () => {
    expect(wages).toEqual([
      { Version_ID: V1, GL_Account_ID: WAGES, GL_Account_Code: '6200', Month: '2026-03', CC1_ID: null, CC2_ID: null, BU_ID: null,
        Amount: 800.03, Source: 'per_head_rollup', Schema_Version: BUDGETS_SCHEMA_VERSION },
      { Version_ID: V1, GL_Account_ID: WAGES, GL_Account_Code: '6200', Month: '2026-04', CC1_ID: null, CC2_ID: null, BU_ID: null,
        Amount: 0.3, Source: 'per_head_rollup', Schema_Version: BUDGETS_SCHEMA_VERSION },
    ]);
    expect(rows.some((r) => r.GL_Account_ID === WAGES && (r.CC1_ID !== null || r.CC2_ID !== null || r.BU_ID !== null))).toBe(false);
  });

  it('every other account is exported cell for cell, natural sign, its own source', () => {
    expect(rows.filter((r) => r.GL_Account_ID === RENT).map((r) => [r.CC1_ID, r.Amount, r.Source]))
      .toEqual([[CC_A, 249.95, 'manual'], [CC_B, 250.05, 'manual']]);
    expect(rows.filter((r) => r.GL_Account_ID === SALES).map((r) => [r.Month, r.Amount]))
      .toEqual([['2026-03', 1000.1], ['2026-04', -0.3]]);
  });

  it('conserves the total: the control total is the same with or without the roll-up, in integer cents', () => {
    const plain = budgetRows([{ versionId: V1, cells: V1_CELLS, perHeadAccountIds: new Set() }], CODES);
    expect(plain.filter((r) => r.GL_Account_ID === WAGES)).toHaveLength(4);
    const total = V1_CELLS.reduce((s, c) => s + cents(c.amount), 0);
    expect(sumCents(rows)).toBe(total);
    expect(sumCents(plain)).toBe(total);
    expect(cents(budgetsSummary(rows, '2026-11-19').controlTotal)).toBe(total);
    expect(budgetsSummary(rows, '2026-11-19').controlTotal).toBe(budgetsSummary(plain, '2026-11-19').controlTotal);
  });

  it('the roll-up is per version: the same account without a per_head line in V2 stays cell for cell', () => {
    const both = budgetRows([
      { versionId: V2, cells: [cell(WAGES, '2026-03', 7, { cc1Id: CC_A })], perHeadAccountIds: new Set() },
      { versionId: V1, cells: V1_CELLS, perHeadAccountIds: new Set([WAGES]) },
    ], CODES);
    expect(both.filter((r) => r.Version_ID === V2)).toEqual([expect.objectContaining({ GL_Account_ID: WAGES, CC1_ID: CC_A, Amount: 7, Source: 'manual' })]);
    expect(both.filter((r) => r.Version_ID === V1 && r.GL_Account_ID === WAGES).every((r) => r.Source === 'per_head_rollup')).toBe(true);
  });

  it('sorts by Version_ID, GL_Account_Code, GL_Account_ID, Month, CC1, CC2, BU (nulls first); at most one dimension per row', () => {
    const many = budgetRows([
      { versionId: V2, cells: [cell(SALES, '2026-04', 1, { buId: CC_B }), cell(SALES, '2026-04', 2), cell(SALES, '2026-03', 3, { cc2Id: CC_A })], perHeadAccountIds: new Set() },
      { versionId: V1, cells: V1_CELLS, perHeadAccountIds: new Set([WAGES]) },
    ], CODES);
    const key = (r: Record<string, unknown>) => [r.Version_ID, r.GL_Account_Code, r.GL_Account_ID, r.Month, r.CC1_ID ?? '', r.CC2_ID ?? '', r.BU_ID ?? ''].join('|');
    expect(many.map(key)).toEqual([...many.map(key)].sort());
    expect(many.filter((r) => r.Version_ID === V2).map((r) => [r.Month, r.CC2_ID, r.BU_ID])).toEqual([['2026-03', CC_A, null], ['2026-04', null, null], ['2026-04', null, CC_B]]);
    for (const r of many) expect([r.CC1_ID, r.CC2_ID, r.BU_ID].filter((x) => x !== null).length).toBeLessThanOrEqual(1);
    expect(Object.keys(many[0]!)).toEqual([...BUDGETS_COLUMNS]);
  });

  it('control total sums in integer cents, never floats (0.1 + 0.2 = 0.30 exactly)', () => {
    const r = budgetRows([{ versionId: V1, cells: [cell(SALES, '2026-03', 0.1), cell(SALES, '2026-04', 0.2)], perHeadAccountIds: new Set() }], CODES);
    expect(budgetsSummary(r, '2026-11-19')).toEqual({
      table: 'budgets', schemaVersion: BUDGETS_SCHEMA_VERSION, asAt: '2026-11-19', rowCount: 2, controlTotal: 0.3,
    });
  });

  it('a float sum drifts (in rand, or ×100 unrounded); the integer-cents sum is exactly 3.67', () => {
    const amounts = [0.07, 1.1, 2.2, 0.1, 0.2]; // the rows' order: months 2026-03..07
    const r = budgetRows([{ versionId: V1, cells: amounts.map((a, i) => cell(SALES, `2026-0${i + 3}`, a)), perHeadAccountIds: new Set() }], CODES);
    expect(amounts.reduce((s, a) => s + a, 0)).not.toBe(3.67);
    expect(amounts.reduce((s, a) => s + a * 100, 0) / 100).not.toBe(3.67);
    expect(budgetsSummary(r, '2026-11-19').controlTotal).toBe(3.67);
  });
});

describe('budgetVersionRows', () => {
  it('one row per version, sorted by Version_ID; token text as given; blank approved/locked when null', () => {
    const rows = budgetVersionRows([
      { id: V2, fiscalYear: 2027, name: 'Scenario', kind: 'scenario', status: 'draft', isPrimary: false,
        updatedAt: '2026-10-26T18:01:02.123457Z', approvedAt: null, lockedAt: null },
      { id: V1, fiscalYear: 2027, name: 'Original', kind: 'original', status: 'locked', isPrimary: true,
        updatedAt: '2026-10-01T08:00:00.000001Z', approvedAt: '2026-09-30T10:00:00.5Z', lockedAt: '2026-10-01T08:00:00.000001Z' },
    ]);
    expect(rows).toEqual([
      { Version_ID: V1, Fiscal_Year: 2027, Name: 'Original', Kind: 'original', Status: 'locked', Is_Primary: true,
        Updated_At: '2026-10-01T08:00:00.000001Z', Approved_At: '2026-09-30T10:00:00.5Z', Locked_At: '2026-10-01T08:00:00.000001Z',
        Schema_Version: 'isaflow-budgets-1.0' },
      { Version_ID: V2, Fiscal_Year: 2027, Name: 'Scenario', Kind: 'scenario', Status: 'draft', Is_Primary: false,
        Updated_At: '2026-10-26T18:01:02.123457Z', Approved_At: null, Locked_At: null, Schema_Version: 'isaflow-budgets-1.0' },
    ]);
    expect(Object.keys(rows[0]!)).toEqual([...BUDGET_VERSIONS_COLUMNS]);
  });
});

const COMPANY = '99999999-0000-4000-8000-000000000009';
const version = (id: string, isPrimary: boolean) => ({
  id, fiscalYear: 2027, name: id === V1 ? 'Original' : 'Scenario', kind: 'original', status: 'draft', isPrimary,
  updatedAt: `2026-11-0${isPrimary ? 1 : 2}T00:00:00.000000Z`, approvedAt: null, lockedAt: null,
});

describe('buildBudgets / buildBudgetVersions (services read per version)', () => {
  beforeEach(() => {
    svc.list.mockReset().mockResolvedValue([version(V2, false), version(V1, true)]);
    svc.chart.mockReset().mockResolvedValue({ accounts: [...CODES].map(([id, code]) => ({ id, code })), members: [] });
    svc.cells.mockReset().mockImplementation(async (_c: string, sel: { versionId: string }) => ({
      versionId: sel.versionId, updatedAt: 'x', cells: sel.versionId === V1 ? V1_CELLS : [cell(WAGES, '2026-03', 7, { cc1Id: CC_A })],
    }));
    // V1: a per_head line on WAGES and a fixed one on RENT; V2: a fixed line on WAGES only.
    svc.drivers.mockReset().mockImplementation(async (_c: string, v: string) => (v === V1
      ? [{ glAccountId: WAGES, kind: 'per_head' }, { glAccountId: RENT, kind: 'fixed' }]
      : [{ glAccountId: WAGES, kind: 'fixed' }]));
  });

  it('rolls up only accounts with a per_head line IN THAT VERSION; other driver kinds stay cell for cell', async () => {
    const out = await buildBudgets(COMPANY, '2026-11-19');
    expect(svc.cells).toHaveBeenCalledWith(COMPANY, { versionId: V1 });
    expect(svc.cells).toHaveBeenCalledWith(COMPANY, { versionId: V2 });
    expect(svc.drivers).toHaveBeenCalledWith(COMPANY, V1);
    const v1Wages = out.rows.filter((r) => r.Version_ID === V1 && r.GL_Account_ID === WAGES);
    expect(v1Wages.map((r) => r.Source)).toEqual(['per_head_rollup', 'per_head_rollup']);
    expect(out.rows.filter((r) => r.Version_ID === V1 && r.GL_Account_ID === RENT).map((r) => r.CC1_ID)).toEqual([CC_A, CC_B]);
    expect(out.rows.filter((r) => r.Version_ID === V2)).toEqual([expect.objectContaining({ CC1_ID: CC_A, Source: 'manual' })]);
    expect(out.summary).toMatchObject({ table: 'budgets', rowCount: out.rows.length, asAt: '2026-11-19' });
    expect(cents(out.summary.controlTotal)).toBe(V1_CELLS.reduce((s, c) => s + cents(c.amount), 0) + 700);
    expect(out.columns).toEqual(BUDGETS_COLUMNS);
  });

  it('versions: every version of the company, by id, no control total', async () => {
    const out = await buildBudgetVersions(COMPANY, '2026-11-19');
    expect(svc.list).toHaveBeenCalledWith(COMPANY);
    expect(out.rows.map((r) => r.Version_ID)).toEqual([V1, V2]);
    expect(out.summary).toEqual({ table: 'budget_versions', schemaVersion: BUDGETS_SCHEMA_VERSION, asAt: '2026-11-19', rowCount: 2 });
    expect(out.summary).not.toHaveProperty('controlTotal');
  });
});
