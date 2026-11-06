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
import { cashFlowPackRows } from '@/modules/accounting/services/reports/packUnstatedRows';
import { buildPackDocument, type PackKvItem } from '@/modules/accounting/services/packs/packDocument';
import { CASH_UNCAPTURED_LABEL } from '@/modules/accounting/services/packs/packSectionData';

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

/**
 * A LEDGER FAULT DOES NOT MOVE OPENING CASH. Operating is the movement the journals explain and the gap travels beside it
 * (`readCashFlows`). Taking opening cash from closing less the three flows alone put the gap in Opening Cash, which then no
 * longer matched the prior period's close. Probe A: 250 of bank debit added to a posted 500 receipt, true opening cash 0.
 */
describe('the report pack cash flow section on a ledger fault', () => {
  const FAULT: ReportPackInput = { ...INPUT, cash: 750, operatingCashFlow: 500, investingCashFlow: 0, financingCashFlow: 0, cashFlowUnexplained: 250 };
  const pack = (input: ReportPackInput) => buildReportPack('management', input, '2026-03-01', '2026-08-31');
  const blob = (input: ReportPackInput) => cashFlowSection(input) as Record<string, unknown>;
  const docItems = (input: ReportPackInput) => {
    const section = buildPackDocument(pack(input), []).sections.find((s) => s.type === 'cash_flow')!;
    return (section.blocks.find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;
  };

  it('opening cash is the true opening, and the net movement is the ledger movement', () => {
    const d = cashFlowSection(FAULT);
    expect(d.operatingCashFlow).toBe(500);
    expect(d.cashFlowUnexplained).toBe(250);
    expect(d.netCashFlow).toBe(750);
    expect(d.openingCash).toBe(0);
    expect(d.closingCash).toBe(750);
  });

  it('the HTML and PDF row list prints the gap between financing and the net, so the column adds up', () => {
    const rows = cashFlowPackRows(blob(FAULT));
    expect(rows.map((r) => r.label)).toEqual([
      'Operating Cash Flow', 'Investing Cash Flow', 'Financing Cash Flow', CASH_UNCAPTURED_LABEL,
      'Net Cash Flow', 'Opening Cash', 'Closing Cash',
    ]);
    expect(rows.map((r) => r.value)).toEqual([500, 0, 0, 250, 750, 0, 750]);
  });

  it('the pack document, which the PDF and the deck print, prints the same row', () => {
    const items = docItems(FAULT);
    expect(items.map((i) => i.value)).toEqual([500, 0, 0, 250, 750, 0, 750]);
    expect(items[3]).toMatchObject({ label: CASH_UNCAPTURED_LABEL, format: 'money' });
  });

  it('prints no such row on a sound ledger', () => {
    for (const gap of [0, undefined]) {
      const input = { ...INPUT, cashFlowUnexplained: gap };
      expect(cashFlowPackRows(blob(input)).map((r) => r.label)).not.toContain(CASH_UNCAPTURED_LABEL);
      expect(docItems(input).map((i) => i.label)).not.toContain(CASH_UNCAPTURED_LABEL);
      expect(cents(cashFlowSection(input).openingCash!)).toBe(cents(OPENING));
    }
  });

  it('a section saved before the field existed still prints, with no row', () => {
    const { cashFlowUnexplained: _dropped, ...saved } = blob(INPUT);
    expect(cashFlowPackRows(saved).map((r) => r.label)).not.toContain(CASH_UNCAPTURED_LABEL);
    const stored = pack(INPUT);
    const old = { ...stored, sections: stored.sections.map((s) => (s.type === 'cash_flow' ? { ...s, data: saved } : s)) };
    expect(() => buildPackDocument(old, [])).not.toThrow();
  });

  it('a gap that is not a number is refused, not printed as nil', () => {
    const stored = pack(FAULT);
    const bad = { ...stored, sections: stored.sections.map((s) => (s.type === 'cash_flow' ? { ...s, data: { ...s.data, cashFlowUnexplained: '250' } } : s)) };
    expect(() => buildPackDocument(bad, [])).toThrow(/cashFlowUnexplained/);
  });
});
