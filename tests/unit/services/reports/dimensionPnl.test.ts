/**
 * P&L by dimension: the columns (one per CC1 / CC2 / BU member, plus untagged)
 * must PARTITION the ungrouped P&L — every band, to the cent.
 *
 * The live proof (each month Apr 2025–Oct 2026, by BU and by CC2) runs against
 * production after deploy; these tests pin the mechanism it relies on:
 *   - every row lands in exactly one column, untagged and unknown included;
 *   - the columns are banded by the SAME classifier as the ungrouped statement,
 *     so Σ columns = aggregateFigures(all rows) for every band;
 *   - the residual is computed in cents, so float dust never reads as a miss,
 *     and a real miss is reported rather than absorbed;
 *   - the cost-centre filter reaches the query (it used to be dropped).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  PNL_BANDS,
  UNTAGGED_KEY,
  bandsOf,
  buildDimensionPnl,
  fetchDimensionAccountRows,
  isZeroResidual,
  residualOf,
  type DimensionAccountRow,
  type DimensionMember,
} from '@/modules/accounting/services/reports/dimensionPnlService';
import { aggregateFigures } from '@/modules/accounting/services/gl/accountClassification';
import { getIncomeStatementByDimension } from '@/modules/accounting/services/reports/incomeStatementService';
import ExcelJS from 'exceljs';
import { addDimensionSheet } from '../../../../pages/api/accounting/income-statement-xlsx';

const CO = '11111111-1111-4111-8111-111111111111';
const FT = 'aaaaaaaa-0000-4000-8000-000000000001';
const HT = 'aaaaaaaa-0000-4000-8000-000000000002';
const ORPHAN = 'aaaaaaaa-0000-4000-8000-0000000000ff';

const ACCOUNTS = [
  { id: 'acc-4000', code: '4000', name: 'Sales', type: 'revenue', subtype: null },
  { id: 'acc-4300', code: '4300', name: 'Interest received', type: 'revenue', subtype: 'other_income' },
  { id: 'acc-5000', code: '5000', name: 'COS - Sub-Contractors', type: 'expense', subtype: 'cost_of_sales' },
  { id: 'acc-5001', code: '5001', name: 'COS - Fuel', type: 'expense', subtype: null },
  { id: 'acc-5800', code: '5800', name: 'Depreciation', type: 'expense', subtype: 'depreciation_expense' },
  { id: 'acc-6000', code: '6000', name: 'Rent', type: 'expense', subtype: 'operating_expenses' },
  { id: 'acc-5810', code: '5810', name: 'Interest paid', type: 'expense', subtype: 'finance_cost' },
] as const;

const row = (
  accountIdx: number, memberId: string | null, debit: number, credit: number, lineCount = 1,
): DimensionAccountRow => {
  const a = ACCOUNTS[accountIdx]!;
  return {
    accountId: a.id, accountCode: a.code, accountName: a.name,
    accountType: a.type, accountSubtype: a.subtype, memberId, debit, credit, lineCount,
  };
};

const MEMBERS = new Map<string, DimensionMember>([
  [FT, { key: FT, memberId: FT, code: 'FT001', name: 'Fibertime', parentCode: null }],
  [HT, { key: HT, memberId: HT, code: 'HT001', name: 'Herotel', parentCode: null }],
]);

/** The ungrouped P&L exactly as getFinancialFigures folds it: per type × subtype. */
function ungrouped(rows: readonly DimensionAccountRow[]) {
  const byKey = new Map<string, { account_type: 'revenue' | 'expense'; account_subtype: string | null; debit: number; credit: number }>();
  for (const r of rows) {
    const k = `${r.accountType}|${r.accountSubtype}`;
    const g = byKey.get(k) ?? { account_type: r.accountType, account_subtype: r.accountSubtype, debit: 0, credit: 0 };
    g.debit += r.debit;
    g.credit += r.credit;
    byKey.set(k, g);
  }
  return bandsOf(aggregateFigures([...byKey.values()]));
}

const FIXTURE: DimensionAccountRow[] = [
  row(0, FT, 0, 5_217_391.30),
  row(0, HT, 120.5, 1_000_000.01),
  row(0, null, 0, 333.33),
  row(1, null, 0, 53_787.07),
  row(2, FT, 1_800_000.99, 1_000),
  row(2, HT, 250_000.1, 0),
  row(2, ORPHAN, 999.99, 0),
  row(3, FT, 12_345.67, 0),
  row(3, null, 7_654.33, 0),
  row(4, null, 25_851.11, 0),
  row(5, HT, 400_000, 0),
  row(6, null, 120_000.02, 0),
];

beforeEach(() => sqlMock.mockReset());

describe('buildDimensionPnl — columns partition the P&L', () => {
  it('ties every band to the ungrouped P&L to the cent, untagged and unknown included', () => {
    const pnl = buildDimensionPnl('cc1', FIXTURE, MEMBERS);
    const total = ungrouped(FIXTURE);

    expect(pnl.total).toEqual(total);
    expect(isZeroResidual(pnl.residual)).toBe(true);
    // Independently: against the per-subtype fold, not the module's own total.
    expect(isZeroResidual(residualOf(total, pnl.columns))).toBe(true);
    for (const band of PNL_BANDS) {
      const sum = pnl.columns.reduce((s, c) => s + Math.round(c[band] * 100), 0) / 100;
      expect(sum).toBeCloseTo(total[band], 2);
    }
  });

  it('gives untagged its own column, last, and keeps an orphan id as UNKNOWN rather than merging it', () => {
    const pnl = buildDimensionPnl('cc1', FIXTURE, MEMBERS);
    expect(pnl.columns.map((c) => c.code)).toEqual(['FT001', 'HT001', 'UNKNOWN', 'UNTAGGED']);
    const untagged = pnl.columns.at(-1)!;
    expect(untagged.key).toBe(UNTAGGED_KEY);
    expect(untagged.memberId).toBeNull();
    expect(untagged.turnover).toBe(333.33);
    expect(untagged.otherIncome).toBe(53_787.07);
    expect(untagged.depreciation).toBe(25_851.11);
    expect(untagged.otherExpenses).toBe(120_000.02);
    const unknown = pnl.columns.find((c) => c.code === 'UNKNOWN')!;
    expect(unknown.costOfSales).toBe(999.99);
    expect(pnl.columns.reduce((s, c) => s + c.lineCount, 0)).toBe(FIXTURE.length);
  });

  it('bands a column with the same classifier as the statement', () => {
    const ft = buildDimensionPnl('cc1', FIXTURE, MEMBERS).columns.find((c) => c.code === 'FT001')!;
    expect(ft.turnover).toBe(5_217_391.3);
    expect(ft.costOfSales).toBe(1_799_000.99); // subtype cost_of_sales, net of the credit
    expect(ft.operatingExpenses).toBe(12_345.67); // unclassified expense defaults to opex
    expect(ft.grossProfit).toBe(round(5_217_391.3 - 1_799_000.99));
    expect(ft.netProfit).toBe(round(5_217_391.3 - 1_799_000.99 - 12_345.67));
  });

  it('ties on 200 random ledgers of cent amounts (no float dust in the residual)', () => {
    let seed = 20261009;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const members = [FT, HT, ORPHAN, null];
    for (let n = 0; n < 200; n++) {
      const rows: DimensionAccountRow[] = [];
      const count = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < count; i++) {
        const cents = () => Math.floor(rand() * 1_000_000_00) / 100;
        rows.push(row(Math.floor(rand() * ACCOUNTS.length), members[Math.floor(rand() * members.length)]!,
          rand() < 0.7 ? cents() : 0, rand() < 0.4 ? cents() : 0));
      }
      const pnl = buildDimensionPnl('bu', rows, MEMBERS);
      expect(isZeroResidual(residualOf(ungrouped(rows), pnl.columns))).toBe(true);
    }
  });

  it('reports a real miss instead of absorbing it', () => {
    const pnl = buildDimensionPnl('cc2', FIXTURE, MEMBERS);
    const short = pnl.columns.slice(0, -1); // drop the untagged column
    const residual = residualOf(pnl.total, short);
    expect(isZeroResidual(residual)).toBe(false);
    expect(residual.turnover).toBe(333.33);
    expect(residual.otherExpenses).toBe(120_000.02);
  });
});

describe('fetchDimensionAccountRows — the filter reaches the query', () => {
  it('binds cost_centre_id against cost_center_id, cc1_id and cc2_id, and business_unit_id against bu_id', async () => {
    sqlMock.mockResolvedValue([]);
    await fetchDimensionAccountRows(CO, '2026-04-01', '2026-04-30', 'cc2', { costCentreId: FT, businessUnitId: HT });
    const [strings, ...values] = sqlMock.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const text = strings.join('$');
    expect(text).toMatch(/jl\.cost_center_id = \$::UUID\s+OR jl\.cc1_id = \$::UUID OR jl\.cc2_id = \$::UUID/);
    expect(text).toMatch(/jl\.bu_id = \$::UUID/);
    expect(values.filter((v) => v === FT).length).toBeGreaterThanOrEqual(4);
    expect(values).toContain(HT);
    expect(values).toContain('cc2');
  });

  it('maps member_id null to an untagged row and parses numeric strings', async () => {
    sqlMock.mockResolvedValue([{
      account_id: 'acc-4000', account_code: '4000', account_name: 'Sales', account_type: 'revenue',
      account_subtype: null, member_id: null, total_debit: '0.00', total_credit: '1234.56', line_count: '3',
    }]);
    const [r] = await fetchDimensionAccountRows(CO, '2026-04-01', '2026-04-30', 'bu');
    expect(r).toMatchObject({ memberId: null, credit: 1234.56, debit: 0, lineCount: 3, accountType: 'revenue' });
  });
});

describe('getIncomeStatementByDimension — the matrix ties to the page statement', () => {
  /** The ungrouped page query: one row per account, the same movement. */
  function pageRows(rows: readonly DimensionAccountRow[]) {
    const byAccount = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const g = byAccount.get(r.accountId) ?? {
        account_code: r.accountCode, account_name: r.accountName, account_type: r.accountType,
        account_subtype: r.accountSubtype, total_debit: 0, total_credit: 0,
      };
      g.total_debit = Number(g.total_debit) + r.debit;
      g.total_credit = Number(g.total_credit) + r.credit;
      byAccount.set(r.accountId, g);
    }
    return [...byAccount.values()];
  }
  const dimRows = (rows: readonly DimensionAccountRow[]) => rows.map((r) => ({
    account_id: r.accountId, account_code: r.accountCode, account_name: r.accountName,
    account_type: r.accountType, account_subtype: r.accountSubtype, member_id: r.memberId,
    total_debit: r.debit, total_credit: r.credit, line_count: r.lineCount,
  }));

  function routeSql(ungroupedRows: unknown[]) {
    sqlMock.mockImplementation((strings: TemplateStringsArray | undefined) => {
      const text = Array.isArray(strings) ? strings.join('$') : '';
      if (text.includes('AS member_id')) return Promise.resolve(dimRows(FIXTURE));
      if (text.includes('FROM cost_centres cc')) {
        return Promise.resolve([...MEMBERS.values()].map((m) => ({ id: m.key, code: m.code, name: m.name, parent_code: null })));
      }
      return Promise.resolve(ungroupedRows);
    });
  }

  it('residual is zero on every band and each account row sums across its members', async () => {
    routeSql(pageRows(FIXTURE));
    const m = await getIncomeStatementByDimension(CO, '2026-04-01', '2026-04-30', 'cc1');
    expect(isZeroResidual(m.residual)).toBe(true);
    expect(m.members.map((x) => x.code)).toEqual(['FT001', 'HT001', 'UNKNOWN', 'UNTAGGED']);
    for (const line of m.lines) {
      const sum = Object.values(line.amounts).reduce((s, a) => s + Math.round(a * 100), 0) / 100;
      expect(sum).toBeCloseTo(line.total, 2);
    }
    const sales = m.lines.find((l) => l.accountCode === '4000')!;
    expect(sales.band).toBe('revenue');
    expect(sales.amounts[UNTAGGED_KEY]).toBe(333.33);
    expect(m.lines.find((l) => l.accountCode === '5810')!.band).toBe('otherExpenses');
  });

  it('a statement that disagrees with the matrix shows up in the residual', async () => {
    const rows = pageRows(FIXTURE);
    rows[0] = { ...rows[0], total_credit: Number(rows[0]!.total_credit) + 10 };
    routeSql(rows);
    const m = await getIncomeStatementByDimension(CO, '2026-04-01', '2026-04-30', 'cc1');
    expect(m.residual.turnover).toBe(10);
    expect(m.residual.netProfit).toBe(10);
    expect(isZeroResidual(m.residual)).toBe(false);
  });
});

describe('xlsx by-dimension sheet', () => {
  it('writes one column per member plus Total, and a tie row that reads as tied', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray | undefined) => {
      const text = Array.isArray(strings) ? strings.join('$') : '';
      if (text.includes('AS member_id')) {
        return Promise.resolve(FIXTURE.map((r) => ({
          account_id: r.accountId, account_code: r.accountCode, account_name: r.accountName,
          account_type: r.accountType, account_subtype: r.accountSubtype, member_id: r.memberId,
          total_debit: r.debit, total_credit: r.credit, line_count: r.lineCount,
        })));
      }
      if (text.includes('FROM cost_centres cc')) {
        return Promise.resolve([...MEMBERS.values()].map((m) => ({ id: m.key, code: m.code, name: m.name, parent_code: null })));
      }
      const byAccount = new Map<string, Record<string, unknown>>();
      for (const r of FIXTURE) {
        const g = byAccount.get(r.accountId) ?? { account_code: r.accountCode, account_name: r.accountName,
          account_type: r.accountType, account_subtype: r.accountSubtype, total_debit: 0, total_credit: 0 };
        g.total_debit = Number(g.total_debit) + r.debit;
        g.total_credit = Number(g.total_credit) + r.credit;
        byAccount.set(r.accountId, g);
      }
      return Promise.resolve([...byAccount.values()]);
    });
    const matrix = await getIncomeStatementByDimension(CO, '2026-04-01', '2026-04-30', 'cc1');
    const wb = new ExcelJS.Workbook();
    const ws = addDimensionSheet(wb, matrix);
    expect(ws.name).toBe('By CC1');
    const header = ws.getRow(4).values as unknown[];
    expect(header.slice(1)).toEqual(['Section', 'Account Code', 'Account Name', 'FT001', 'HT001', 'UNKNOWN', 'UNTAGGED', 'Total']);
    let tieLabel = '';
    ws.eachRow((row) => {
      const v = String(row.getCell(1).value ?? '');
      if (v.includes('Income Statement sheet')) tieLabel = v;
    });
    expect(tieLabel).toBe('Ties to the Income Statement sheet');
  });
});

function round(v: number) {
  return Math.round(v * 100) / 100;
}
