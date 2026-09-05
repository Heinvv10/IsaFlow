/**
 * The report pack's key mapping. `packToTotals` and `packToBsTotals` read
 * string keys off `section.data` with a numeric fallback: rename one in
 * `reportPackService` and the pack renders a plausible statement of zeros,
 * with no compile error and nothing failing. This test asserts the mapper's
 * output against the figures the SERVICE emitted for the same input, so a
 * rename on either side is caught.
 */
import { describe, it, expect } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { packToTotals, packToMargins, packToBsTotals, packToBsDetail } from '@/components/accounting/packMappers';

/** Brightsphere, all-time — the tenant whose pack was short by R341,712.00. */
const INPUT: ReportPackInput = {
  companyName: 'Brightsphere', period: '2020-01-01 to 2030-12-31',
  revenue: 13485163.41, costOfSales: 0, operatingExpenses: 4748602.81,
  otherIncome: 23323.42, otherExpenses: 365035.42, operatingProfit: 8759884.02,
  netProfit: 8394848.60,
  totalAssets: 2500000, totalLiabilities: 900000, totalEquity: 1600000,
  currentAssets: 1200000, currentLiabilities: 700000, cash: 350000,
  accountsReceivable: 480000, accountsPayable: 260000, inventory: 0,
  inventoryCaveat: null, classificationCaveat: null,
};

const section = (type: string): Record<string, unknown> => {
  const pack = buildReportPack('management', INPUT, '2020-01-01', '2030-12-31');
  const found = pack.sections.find(x => x.type === type);
  if (!found) throw new Error(`no ${type} section in the pack`);
  return found.data as Record<string, unknown>;
};

describe('packToTotals', () => {
  it('maps every P&L band the service emits, by value not by position', () => {
    const d = section('income_statement');
    const t = packToTotals(d);
    expect(t.totalRevenue).toBeCloseTo(Number(d.revenue), 2);
    expect(t.totalCostOfSales).toBeCloseTo(Number(d.costOfSales), 2);
    expect(t.grossProfit).toBeCloseTo(Number(d.grossProfit), 2);
    expect(t.totalOtherIncome).toBeCloseTo(Number(d.otherIncome), 2);
    expect(t.totalOperatingExpenses).toBeCloseTo(Number(d.operatingExpenses), 2);
    expect(t.operatingProfit).toBeCloseTo(Number(d.operatingProfit), 2);
    expect(t.totalOtherExpenses).toBeCloseTo(Number(d.otherExpenses), 2);
    expect(t.netProfit).toBeCloseTo(Number(d.netProfit), 2);
  });

  it('the mapped totals still FOOT, so a rename cannot pass unnoticed', () => {
    const t = packToTotals(section('income_statement'));
    expect(t.grossProfit! + t.totalOtherIncome! - t.totalOperatingExpenses!)
      .toBeCloseTo(t.operatingProfit!, 2);
    expect(t.operatingProfit! - t.totalOtherExpenses!).toBeCloseTo(t.netProfit!, 2);
    // Not all zeros: the whole failure mode this guards is a silent zero pack.
    expect(Object.values(t).some(v => v !== 0)).toBe(true);
  });

  it('carries both margins the pack prints', () => {
    const d = section('income_statement');
    const m = packToMargins(d);
    expect(m.grossMargin).toBeCloseTo(Number(d.grossMargin), 2);
    expect(m.netMargin).toBeCloseTo(Number(d.netMargin), 2);
    expect(m.netMargin).toBeGreaterThan(0);
  });
});

describe('packToBsTotals and packToBsDetail', () => {
  it('map the balance-sheet keys the service emits', () => {
    const d = section('balance_sheet');
    const t = packToBsTotals(d);
    expect(t.totalAssets).toBeCloseTo(Number(d.totalAssets), 2);
    expect(t.totalLiabilities).toBeCloseTo(Number(d.totalLiabilities), 2);
    expect(t.totalEquity).toBeCloseTo(Number(d.totalEquity), 2);

    const detail = packToBsDetail(d);
    expect(detail.currentAssets).toBeCloseTo(Number(d.currentAssets), 2);
    expect(detail.cash).toBeCloseTo(Number(d.cash), 2);
    expect(detail.accountsReceivable).toBeCloseTo(Number(d.accountsReceivable), 2);
    expect(detail.accountsPayable).toBeCloseTo(Number(d.accountsPayable), 2);
  });

  it('coerces a non-numeric value to 0 rather than letting it reach the grid', () => {
    // The cast the page used to do (`d as Record<string, number>`) let a string
    // through, and the derived Total Liabilities and Equity concatenated it.
    const t = packToBsTotals({ totalAssets: '900000' as unknown, totalLiabilities: 100, totalEquity: 200 });
    expect(t.totalAssets).toBe(0);
    expect(t.totalLiabilities! + t.totalEquity!).toBe(300);
  });
});
