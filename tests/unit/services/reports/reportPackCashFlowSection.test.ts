/**
 * THE MANAGEMENT AND MONTHLY PACK'S CASH FLOW SECTION FOOTS.
 *
 * The section took investing as capital expenditure negated and nothing else.
 * Once the pack input carried real operating and financing figures and no
 * capex, it printed investing as nil and an opening cash that was wrong by
 * the whole investing flow — on the PDF and the deck a bank is sent.
 *
 * Figures shaped like a ledger's: cents, not round thousands.
 */
import { describe, expect, it } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const OPENING = 1_787_567.21;
const OPERATING = 345_678.12;
const INVESTING = -98_765.43;
const FINANCING = 12_345.67;
const CLOSING = 2_046_825.57;

const INPUT: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_000,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: CLOSING, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
  operatingCashFlow: OPERATING, investingCashFlow: INVESTING, financingCashFlow: FINANCING,
};

function cashFlowSection(input: ReportPackInput): Record<string, number> {
  const section = buildReportPack('management', input, '2026-03-01', '2026-08-31')
    .sections.find((s) => s.type === 'cash_flow');
  if (section === undefined) throw new Error('the management pack has no cash_flow section');
  return section.data as Record<string, number>;
}

const cents = (n: number): number => Math.round(n * 100);

describe('the report pack cash flow section', () => {
  it('prints investing from the net investing cash flow', () => {
    expect(cashFlowSection(INPUT).investingCashFlow).toBe(INVESTING);
  });

  it('foots to the cent: opening plus the three flows is closing', () => {
    const d = cashFlowSection(INPUT);
    expect(cents(d.openingCash!)).toBe(cents(OPENING));
    expect(cents(d.netCashFlow!)).toBe(cents(OPERATING) + cents(INVESTING) + cents(FINANCING));
    expect(cents(d.openingCash!) + cents(d.operatingCashFlow!) + cents(d.investingCashFlow!) + cents(d.financingCashFlow!))
      .toBe(cents(d.closingCash!));
    expect(d.closingCash).toBe(CLOSING);
  });

  it('still takes investing from capital expenditure where no investing figure is carried', () => {
    const d = cashFlowSection({ ...INPUT, investingCashFlow: undefined, capitalExpenditure: 150_000 });
    expect(d.investingCashFlow).toBe(-150_000);
    expect(cents(d.openingCash!)).toBe(cents(CLOSING - (OPERATING - 150_000 + FINANCING)));
  });

  it('prefers the investing figure over capital expenditure when both are carried', () => {
    // Net investing is the cash that moved; capex is one part of it.
    const d = cashFlowSection({ ...INPUT, capitalExpenditure: 150_000 });
    expect(d.investingCashFlow).toBe(INVESTING);
    expect(cents(d.openingCash!)).toBe(cents(OPENING));
  });
});
