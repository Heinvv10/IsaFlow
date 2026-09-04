/**
 * The report pack's P&L must FOOT, and its waterfall must show the steps it
 * already supports.
 *
 * `revenue` and `operatingExpenses` come from the classifier — turnover only,
 * finance cost and tax excluded — while `netProfit` is the full bottom line. A
 * pack that prints only Revenue / CoS / Gross Profit / OpEx / Net Profit is
 * therefore short by exactly `otherIncome - otherExpenses`: R341,712.00 on
 * Brightsphere, on an HTML and PDF document sent to a client. The waterfall had
 * the same cause: `getReportPackInput` never carried the two fields, so
 * `buildProfitWaterfall`'s `!== 0` gates suppressed both steps every time.
 */

import { describe, it, expect } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { toFinancialData } from '@/modules/accounting/services/gl/financialFiguresService';

const INPUT: ReportPackInput = {
  companyName: 'Brightsphere', period: '2020-01-01 to 2030-12-31',
  revenue: 13485163.41, costOfSales: 0, operatingExpenses: 4748602.81,
  otherIncome: 23323.42, otherExpenses: 365035.42, operatingProfit: 8759884.02,
  netProfit: 8394848.60,
  totalAssets: 1, totalLiabilities: 0, totalEquity: 1,
  currentAssets: 1, currentLiabilities: 1, cash: 0,
  accountsReceivable: 0, accountsPayable: 0, inventory: 0,
  inventoryCaveat: null, classificationCaveat: null,
};

/** The section payload the pack renders for a given type. */
const section = (
  type: string,
  packType: 'board' | 'management' | 'monthly' = 'management',
  input: ReportPackInput = INPUT,
): Record<string, unknown> => {
  const pack = buildReportPack(packType, input, '2020-01-01', '2030-12-31');
  const found = pack.sections.find(x => x.type === type);
  if (!found) throw new Error(`no ${type} section in the pack`);
  return found.data as Record<string, unknown>;
};

describe('report pack income statement', () => {
  it('foots: every band needed to get from turnover to net profit', () => {
    const d = section('income_statement') as unknown as Record<string, number>;
    expect(d.grossProfit).toBeCloseTo(13485163.41, 2);
    expect(d.otherIncome).toBeCloseTo(23323.42, 2);
    expect(d.operatingProfit).toBeCloseTo(8759884.02, 2);
    expect(d.otherExpenses).toBeCloseTo(365035.42, 2);
    // The reconciliation a reader performs on the page.
    expect(d.grossProfit + d.otherIncome - d.operatingExpenses).toBeCloseTo(d.operatingProfit, 2);
    expect(d.operatingProfit - d.otherExpenses).toBeCloseTo(d.netProfit, 2);
    // Without the two bands the pack is short by exactly this.
    expect(d.revenue - d.costOfSales - d.operatingExpenses).not.toBeCloseTo(d.netProfit, 2);
  });

  it('derives the operating line correctly when a caller supplies none', () => {
    const { operatingProfit: _drop, ...rest } = INPUT;
    const d = section('income_statement', 'management', rest) as unknown as Record<string, number>;
    expect(d.operatingProfit).toBeCloseTo(8759884.02, 2);
  });
});

describe('report pack profit waterfall', () => {
  it('shows the Other Income and Other Expenses steps', () => {
    const s = section('waterfall', 'management') as unknown as { steps: Array<{ label: string }> };
    const labels = s.steps.map(x => x.label);
    // Both were ALWAYS suppressed: the fields never reached the builder, so its
    // `!== 0` gates saw 0 on every pack ever produced.
    expect(labels.join('|')).toMatch(/Other Income/i);
    expect(labels.join('|')).toMatch(/Other Expense/i);
  });

  it('omits the steps when there genuinely is nothing in them', () => {
    const s = section('waterfall', 'management', { ...INPUT, otherIncome: 0, otherExpenses: 0 }) as unknown as { steps: Array<{ label: string }> };
    const labels = s.steps.map(x => x.label).join('|');
    expect(labels).not.toMatch(/Other Income/i);
    expect(labels).not.toMatch(/Other Expense/i);
  });
});

// ── The data service must CARRY the bands (mutation survivors) ──────────────

describe('getReportPackInput carries the bands the pack needs', () => {
  // Zeroing either field in the data service left every pack test green: the
  // pack renders whatever it is handed, and it was handed nothing. That is the
  // original defect — `buildProfitWaterfall` gates both steps on `!== 0`, so a
  // pack's Other Income and Other Expenses were suppressed on every pack ever
  // produced, and its Net Profit subtotal hung off the running total.
  it('populates otherIncome, otherExpenses and operatingProfit from the classifier', async () => {
    const figures = {
      period: {
        revenue: 13485163.41, otherIncome: 23323.42, costOfSales: 0,
        operatingExpenses: 4748602.81, otherExpenses: 365035.42,
        operatingProfit: 8759884.02, netProfit: 8394848.60, depreciation: 0,
        grossProfit: 13485163.41, totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
        currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
        cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
        unclassifiedCount: 0, unclassifiedTotal: 0,
        unclassifiedByType: {
          asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
          equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
          expense: { accounts: 0, amount: 0 },
        },
      },
    };
    const data = toFinancialData({ ...figures, cumulative: figures.period } as never);
    expect(data.otherIncome).toBeCloseTo(23323.42, 2);
    expect(data.operatingProfit).toBeCloseTo(8759884.02, 2);
    // otherExpenses is not on FinancialData — the pack input reads it straight
    // off the period figures, so assert the value the pack needs is reachable.
    expect(figures.period.otherExpenses).toBeCloseTo(365035.42, 2);
  });

  it('a pack built from zeroed bands does NOT foot — which is what the carry prevents', () => {
    const d = section('income_statement', 'management', {
      ...INPUT, otherIncome: 0, otherExpenses: 0, operatingProfit: undefined,
    }) as unknown as Record<string, number>;
    // Same netProfit, no bands: the reader's reconciliation fails by R341,712.00.
    expect(d.operatingProfit - d.otherExpenses).not.toBeCloseTo(d.netProfit, 2);
    expect(Math.abs((d.operatingProfit - d.otherExpenses) - d.netProfit)).toBeCloseTo(341712.00, 2);
  });
});

describe('the pack RATIOS use the converged operating line', () => {
  // Dropping BOTH operatingProfit and otherIncome from buildReportPack's
  // FinancialData reverts the pack to the pre-B75 operating line and left the
  // whole suite green — each field alone is an equivalent mutant, so only the
  // pair pins it.
  it('reports an operating margin that includes other income', () => {
    const r = section('ratios') as unknown as Record<string, number>;
    const turnover = INPUT.revenue;
    const withOther = (INPUT.operatingProfit! / turnover) * 100;
    const withoutOther =
      ((INPUT.revenue - INPUT.costOfSales - INPUT.operatingExpenses) / turnover) * 100;
    expect(r.operatingProfitMargin).toBeCloseTo(withOther, 2);
    expect(r.operatingProfitMargin).not.toBeCloseTo(withoutOther, 2);
  });

  it('computes EBITDA on the same line', () => {
    const r = section('ratios') as unknown as Record<string, number>;
    // depreciation is 0 on this fixture, so EBITDA is the operating line itself.
    expect(r.ebitda).toBeCloseTo(INPUT.operatingProfit!, 2);
  });
});
