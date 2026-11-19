/**
 * budget_versions / budgets export tables (FibreFlow contract isaflow-budgets-1.0).
 *
 * Pure part (budgetsExportRows): column order, the version row's fields, the
 * per-head roll-up (D7, salary privacy: an account in the rolled-up set leaves
 * only company-level rows, one per month, summing every cell of it, in EVERY
 * version), the rolled-up set (per_head lines in ANY version, closed over
 * pct_of_line / pct_of_section dependents), the deterministic sort and the
 * control total in integer cents. Async part (budgetsExport): which services
 * are read, the set applied across versions (a copy carries no driver lines),
 * a version whose financial year is not in the registry skipped. The real
 * database (every version, the variance tie, the tenant boundary) is
 * tests/integration/budgets-export.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: svc.warn, debug: vi.fn() } }));

const svc = vi.hoisted(() => ({ list: vi.fn(), cells: vi.fn(), drivers: vi.fn(), chart: vi.fn(), bands: vi.fn(), warn: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ listVersions: svc.list }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridCells: svc.cells }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', () => ({ listDriverLines: svc.drivers }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', () => ({ loadChartRefs: svc.chart }));
vi.mock('@/modules/accounting/services/budgets/gridReadAccounts', () => ({ loadAccountBands: svc.bands }));

import {
  BUDGETS_COLUMNS, BUDGETS_SCHEMA_VERSION, BUDGET_VERSIONS_COLUMNS, budgetRows, budgetVersionRows, budgetsSummary, rolledUpAccounts,
} from '@/modules/accounting/services/reports/budgetsExportRows';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { buildBudgetVersions, buildBudgets } from '@/modules/accounting/services/reports/budgetsExport';
import type { GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';

const V1 = '11111111-0000-4000-8000-000000000001';
const V2 = '22222222-0000-4000-8000-000000000002';
const SALES = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WAGES = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RENT = 'cccccccc-0000-4000-8000-00000000000c';
const BONUS = 'ffffffff-0000-4000-8000-00000000000f';
const LEVY = '12121212-0000-4000-8000-000000000012';
const CC_A = 'dddddddd-0000-4000-8000-00000000000d';
const CC_B = 'eeeeeeee-0000-4000-8000-00000000000e';
const CODES = new Map([[SALES, '4000'], [WAGES, '6200'], [RENT, '6100'], [BONUS, '6210'], [LEVY, '6300']]);

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
  const rows = budgetRows([{ versionId: V1, cells: V1_CELLS }], new Set([WAGES]), CODES);
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
    const plain = budgetRows([{ versionId: V1, cells: V1_CELLS }], new Set(), CODES);
    expect(plain.filter((r) => r.GL_Account_ID === WAGES)).toHaveLength(4);
    const total = V1_CELLS.reduce((s, c) => s + cents(c.amount), 0);
    expect(sumCents(rows)).toBe(total);
    expect(sumCents(plain)).toBe(total);
    expect(cents(budgetsSummary(rows, '2026-11-19').controlTotal)).toBe(total);
    expect(budgetsSummary(rows, '2026-11-19').controlTotal).toBe(budgetsSummary(plain, '2026-11-19').controlTotal);
  });

  it('the set applies to EVERY version: a copy without the per_head line rolls the account up too', () => {
    const both = budgetRows([
      { versionId: V2, cells: [cell(WAGES, '2026-03', 7, { cc1Id: CC_A }), cell(WAGES, '2026-03', 3, { cc1Id: CC_B })] },
      { versionId: V1, cells: V1_CELLS },
    ], new Set([WAGES]), CODES);
    expect(both.filter((r) => r.Version_ID === V2)).toEqual([expect.objectContaining({
      GL_Account_ID: WAGES, CC1_ID: null, CC2_ID: null, BU_ID: null, Amount: 10, Source: 'per_head_rollup',
    })]);
    expect(both.filter((r) => r.GL_Account_ID === WAGES).every((r) => r.Source === 'per_head_rollup' && r.CC1_ID === null)).toBe(true);
  });

  it('sorts by Version_ID, GL_Account_Code, GL_Account_ID, Month, CC1, CC2, BU (nulls first); at most one dimension per row', () => {
    const many = budgetRows([
      { versionId: V2, cells: [cell(SALES, '2026-04', 1, { buId: CC_B }), cell(SALES, '2026-04', 2), cell(SALES, '2026-03', 3, { cc2Id: CC_A })] },
      { versionId: V1, cells: V1_CELLS },
    ], new Set([WAGES]), CODES);
    const key = (r: Record<string, unknown>) => [r.Version_ID, r.GL_Account_Code, r.GL_Account_ID, r.Month, r.CC1_ID ?? '', r.CC2_ID ?? '', r.BU_ID ?? ''].join('|');
    expect(many.map(key)).toEqual([...many.map(key)].sort());
    expect(many.filter((r) => r.Version_ID === V2).map((r) => [r.Month, r.CC2_ID, r.BU_ID])).toEqual([['2026-03', CC_A, null], ['2026-04', null, null], ['2026-04', null, CC_B]]);
    for (const r of many) expect([r.CC1_ID, r.CC2_ID, r.BU_ID].filter((x) => x !== null).length).toBeLessThanOrEqual(1);
    expect(Object.keys(many[0]!)).toEqual([...BUDGETS_COLUMNS]);
  });

  it('control total sums in integer cents, never floats (0.1 + 0.2 = 0.30 exactly)', () => {
    const r = budgetRows([{ versionId: V1, cells: [cell(SALES, '2026-03', 0.1), cell(SALES, '2026-04', 0.2)] }], new Set(), CODES);
    expect(budgetsSummary(r, '2026-11-19')).toEqual({
      table: 'budgets', schemaVersion: BUDGETS_SCHEMA_VERSION, asAt: '2026-11-19', rowCount: 2, controlTotal: 0.3,
    });
  });

  it('a float sum drifts (in rand, or ×100 unrounded); the integer-cents sum is exactly 3.67', () => {
    const amounts = [0.07, 1.1, 2.2, 0.1, 0.2]; // the rows' order: months 2026-03..07
    const r = budgetRows([{ versionId: V1, cells: amounts.map((a, i) => cell(SALES, `2026-0${i + 3}`, a)) }], new Set(), CODES);
    expect(amounts.reduce((s, a) => s + a, 0)).not.toBe(3.67);
    expect(amounts.reduce((s, a) => s + a * 100, 0) / 100).not.toBe(3.67);
    expect(budgetsSummary(r, '2026-11-19').controlTotal).toBe(3.67);
  });
});

type Line = Parameters<typeof rolledUpAccounts>[0][number];
const line = (glAccountId: string, kind: Line['kind'], o: Partial<Line> = {}): Line => ({ glAccountId, kind, ref: null, section: null, ...o });
const BANDS = new Map([[SALES, 'turnover'], [WAGES, 'operating_expense'], [RENT, 'operating_expense'], [BONUS, 'operating_expense'], [LEVY, 'other_expense']] as const);

describe('rolledUpAccounts: per_head accounts and everything derived from them, to a fixed point', () => {
  it('per_head lines of every version; other kinds alone add nothing', () => {
    expect(rolledUpAccounts([line(WAGES, 'per_head'), line(RENT, 'fixed'), line(SALES, 'growth')], BANDS)).toEqual(new Set([WAGES]));
    expect(rolledUpAccounts([line(RENT, 'fixed')], BANDS)).toEqual(new Set());
  });

  it('pct_of_line on a rolled account joins, and so does a pct_of_line on THAT (transitive)', () => {
    const lines = [
      line(LEVY, 'pct_of_line', { ref: { glAccountId: BONUS, cc1Id: null, cc2Id: null, buId: null } }), // listed before its source
      line(BONUS, 'pct_of_line', { ref: { glAccountId: WAGES, cc1Id: CC_A, cc2Id: null, buId: null }, cc1Id: CC_A } as Partial<Line>),
      line(WAGES, 'per_head'),
      line(SALES, 'pct_of_line', { ref: { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null } }),
    ];
    expect(rolledUpAccounts(lines, BANDS)).toEqual(new Set([WAGES, BONUS, LEVY]));
  });

  it('pct_of_section on a band holding a rolled account joins; on another band it does not', () => {
    expect(rolledUpAccounts([line(WAGES, 'per_head'), line(LEVY, 'pct_of_section', { section: 'operating_expense' })], BANDS))
      .toEqual(new Set([WAGES, LEVY]));
    expect(rolledUpAccounts([line(WAGES, 'per_head'), line(LEVY, 'pct_of_section', { section: 'turnover' })], BANDS))
      .toEqual(new Set([WAGES]));
    // A section dependent's own band then counts: SALES on other_expense joins through LEVY.
    expect(rolledUpAccounts([
      line(SALES, 'pct_of_section', { section: 'other_expense' }),
      line(WAGES, 'per_head'), line(LEVY, 'pct_of_line', { ref: { glAccountId: WAGES, cc1Id: null, cc2Id: null, buId: null } }),
    ], BANDS)).toEqual(new Set([WAGES, LEVY, SALES]));
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

describe('buildBudgets / buildBudgetVersions', () => {
  beforeEach(() => {
    svc.warn.mockReset();
    svc.list.mockReset().mockResolvedValue([version(V2, false), version(V1, true)]);
    svc.chart.mockReset().mockResolvedValue({ accounts: [...CODES].map(([id, code]) => ({ id, code })), members: [] });
    svc.bands.mockReset().mockResolvedValue(BANDS);
    svc.cells.mockReset().mockImplementation(async (_c: string, sel: { versionId: string }) => ({
      versionId: sel.versionId, updatedAt: 'x',
      cells: sel.versionId === V1 ? V1_CELLS : [cell(WAGES, '2026-03', 7, { cc1Id: CC_A }), cell(RENT, '2026-03', 5, { cc1Id: CC_A })],
    }));
    // V1: a per_head line on WAGES and a fixed one on RENT; V2 (a copy): driver lines are not copied.
    svc.drivers.mockReset().mockImplementation(async (_c: string, v: string) => (v === V1
      ? [line(WAGES, 'per_head'), line(RENT, 'fixed')]
      : []));
  });

  it('a version copied WITHOUT the per_head line still rolls the account up (union over every version)', async () => {
    const out = await buildBudgets(COMPANY, '2026-11-19');
    expect(svc.cells).toHaveBeenCalledWith(COMPANY, { versionId: V1 });
    expect(svc.cells).toHaveBeenCalledWith(COMPANY, { versionId: V2 });
    expect(svc.drivers).toHaveBeenCalledWith(COMPANY, V1);
    expect(svc.drivers).toHaveBeenCalledWith(COMPANY, V2);
    expect(out.rows.filter((r) => r.Version_ID === V1 && r.GL_Account_ID === WAGES).map((r) => r.Source)).toEqual(['per_head_rollup', 'per_head_rollup']);
    expect(out.rows.filter((r) => r.Version_ID === V2 && r.GL_Account_ID === WAGES))
      .toEqual([expect.objectContaining({ CC1_ID: null, Amount: 7, Source: 'per_head_rollup' })]);
    // Rent (a fixed driver only) stays cell for cell in both.
    expect(out.rows.filter((r) => r.GL_Account_ID === RENT).map((r) => r.CC1_ID)).toEqual([CC_A, CC_B, CC_A]);
    expect(out.summary).toMatchObject({ table: 'budgets', rowCount: out.rows.length, asAt: '2026-11-19' });
    expect(cents(out.summary.controlTotal)).toBe(V1_CELLS.reduce((s, c) => s + cents(c.amount), 0) + 1200);
    expect(out.columns).toEqual(BUDGETS_COLUMNS);
  });

  it('a pct_of_line dependent of the per_head account (in any version) is rolled up too', async () => {
    svc.drivers.mockImplementation(async (_c: string, v: string) => (v === V1
      ? [line(WAGES, 'per_head')]
      : [line(RENT, 'pct_of_line', { ref: { glAccountId: WAGES, cc1Id: CC_A, cc2Id: null, buId: null } })]));
    const out = await buildBudgets(COMPANY, '2026-11-19');
    expect(out.rows.filter((r) => r.GL_Account_ID === RENT).every((r) => r.Source === 'per_head_rollup' && r.CC1_ID === null)).toBe(true);
  });

  it('a version whose financial year is not in the registry is skipped with a warning naming it; the rest export', async () => {
    svc.cells.mockImplementation(async (_c: string, sel: { versionId: string }) => {
      if (sel.versionId === V2) throw new FiscalYearLabelUnknownError(COMPANY, 2031);
      return { versionId: V1, updatedAt: 'x', cells: V1_CELLS };
    });
    const out = await buildBudgets(COMPANY, '2026-11-19');
    expect(out.rows.some((r) => r.Version_ID === V2)).toBe(false);
    expect(out.rows.filter((r) => r.Version_ID === V1)).toHaveLength(6);
    expect(svc.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versionId: V2 }), expect.any(String));
  });

  it('any other failure of a version still fails the export', async () => {
    svc.cells.mockRejectedValue(new Error('boom'));
    await expect(buildBudgets(COMPANY, '2026-11-19')).rejects.toThrow('boom');
  });

  it('versions: every version of the company, by id, no control total', async () => {
    const out = await buildBudgetVersions(COMPANY, '2026-11-19');
    expect(svc.list).toHaveBeenCalledWith(COMPANY);
    expect(out.rows.map((r) => r.Version_ID)).toEqual([V1, V2]);
    expect(out.summary).toEqual({ table: 'budget_versions', schemaVersion: BUDGETS_SCHEMA_VERSION, asAt: '2026-11-19', rowCount: 2 });
    expect(out.summary).not.toHaveProperty('controlTotal');
  });
});
