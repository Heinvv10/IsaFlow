/**
 * What a shared link carries, proved against a REAL pack rather than a fixture
 * of section names — the point of the omission list is that it matches what
 * `buildReportPack` actually emits, and a hand-written section array cannot
 * fail when the pack template gains a section.
 *
 * `cash_flow` is the one this suite exists for. `buildSectionData` synthesizes
 * it (operating cash flow = net profit, investing = financing = 0) because
 * nothing supplies the three optional inputs, so the numbers under that heading
 * are not a cash flow the ledger produced. Drawn as money to an outsider they
 * read as one.
 */
import { describe, it, expect } from 'vitest';
import { buildReportPack, type PackType, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { stripOmittedSections, OMITTED_SECTIONS } from '@/modules/accounting/services/share/sharedSections';

const INPUT: ReportPackInput = {
  companyName: 'Brightsphere (Pty) Ltd',
  period: '2026-03-01 to 2026-08-31',
  revenue: 5_000_000, costOfSales: 3_000_000, operatingExpenses: 1_200_000, netProfit: 640_000,
  totalAssets: 9_000_000, totalLiabilities: 4_000_000, totalEquity: 5_000_000,
  currentAssets: 3_000_000, currentLiabilities: 1_500_000,
  cash: 750_000, accountsReceivable: 1_100_000, accountsPayable: 900_000, inventory: 400_000,
  otherIncome: 60_000, otherExpenses: 20_000,
};

function shared(type: PackType) {
  return stripOmittedSections(buildReportPack(type, INPUT, '2026-03-01', '2026-08-31'));
}

describe('stripOmittedSections — the synthesized cash flow', () => {
  it.each(['management', 'monthly'] as const)('carries no cash_flow figures on a %s pack', (type) => {
    const pack = shared(type);
    const cashFlow = pack.sections.find(s => s.type === 'cash_flow');

    // The section is still NAMED — the reader must see what the pack contains
    // and that they are not being shown it.
    expect(cashFlow).toBeDefined();
    expect(cashFlow!.title).toBe('Cash Flow');
    expect(cashFlow).not.toHaveProperty('data');

    // And nothing anywhere in the shipped props carries the synthesized number.
    // netProfit IS the synthesized operating cash flow, so this asserts the key
    // is gone rather than that a value happens not to appear.
    const keys = pack.sections.flatMap(s => Object.keys(s.data ?? {}));
    expect(keys).not.toContain('operatingCashFlow');
    expect(keys).not.toContain('netCashFlow');
    expect(keys).not.toContain('closingCash');
  });

  it('leaves the two statements the ledger does produce intact', () => {
    const pack = shared('management');
    expect(pack.sections.find(s => s.type === 'income_statement')?.data?.revenue).toBe(5_000_000);
    expect(pack.sections.find(s => s.type === 'balance_sheet')?.data?.totalAssets).toBe(9_000_000);
  });

  it('names cash_flow among the omitted sections, so the view draws the note', () => {
    expect(OMITTED_SECTIONS.has('cash_flow')).toBe(true);
  });
});
