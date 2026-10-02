/**
 * THE LEGACY PACK'S EBITDA IS THE BOARD PACK'S EBITDA.
 *
 * EBITDA is operating profit plus depreciation and amortisation.
 * `getReportPackInput` carries the period's depreciation charge, and
 * `buildReportPack` did not hand it to the ratio engine — so the management
 * and monthly packs printed an "EBITDA" equal to operating profit to the rand
 * (−1 819 000 on Brightsphere) beside a board pack that printed the real one
 * ((1 971) in R'000) for the same company and period.
 */
import { describe, expect, it } from 'vitest';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { packFiguresToFinancialData } from '@/modules/accounting/services/packs/pages/packScorecard';
import { buildPackDocument, type PackKvItem } from '@/modules/accounting/services/packs/packDocument';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';

/** As `getReportPackInput` returns it: operating profit carried, and a
 *  depreciation charge that is not zero. */
const INPUT: ReportPackFigures = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000,
  otherIncome: 23_323.42, otherExpenses: 65_035.42, operatingProfit: 733_323.42, netProfit: 668_288,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825.57, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
  depreciation: 152_480.75, inventoryCaveat: null, classificationCaveat: null, cashFlowUnavailable: null,
};

function legacyRatios(input: ReportPackFigures): Record<string, unknown> {
  return buildReportPack('management', input, '2026-03-01', '2026-08-31')
    .sections.find((s) => s.type === 'ratios')!.data;
}

describe('EBITDA in the management pack', () => {
  const board = calculateExtendedRatios(packFiguresToFinancialData(INPUT));

  it('adds the depreciation charge back to operating profit', () => {
    expect(legacyRatios(INPUT).ebitda).toBe(885_804.17);
    expect(legacyRatios(INPUT).ebitda).not.toBe(INPUT.operatingProfit);
  });

  it('equals the board pack\'s EBITDA for the same input', () => {
    expect(legacyRatios(INPUT).ebitda).toBe(board.ebitda);
  });

  it('states the EBITDA margin the board pack states', () => {
    expect(legacyRatios(INPUT).ebitdaMargin).toBe(board.ebitdaMargin);
    expect(legacyRatios(INPUT).ebitdaMargin).toBe(21.09);
  });

  it('prints it in the document a reader is sent', () => {
    const document = buildPackDocument(buildReportPack('management', INPUT, '2026-03-01', '2026-08-31'), []);
    const items = (document.sections.find((s) => s.type === 'ratios')!.blocks
      .find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;
    expect(items.find((i) => i.label === 'EBITDA')!.value).toBe(885_804.17);
  });

  it('is operating profit where the period carries no depreciation charge', () => {
    expect(legacyRatios({ ...INPUT, depreciation: 0 }).ebitda).toBe(733_323.42);
  });
});
