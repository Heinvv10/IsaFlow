/**
 * THE OPERATING CASH FLOW RATIO IS NOT 0.00 WHEN NO CASH FLOW WAS READ.
 *
 * `calculateExtendedRatios` divides operating cash flow by current
 * liabilities and reads an absent operating cash flow as zero. Where the cash
 * flow statement could not be read, the report pack printed "Operating Cash
 * Flow Ratio 0.00" — a measurement — two sections after a cash flow section
 * saying the statement was not read. It is marked not meaningful in the
 * pack's own ratios, as free cash flow is; the shared engine is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn(), error: vi.fn() } }));

import {
  buildReportPack, packRatios, NO_OPERATING_CASH_FLOW_RATIO, type ReportPackInput,
} from '@/modules/accounting/services/reports/reportPackService';
import { buildPackDocument, type PackKvItem } from '@/modules/accounting/services/packs/packDocument';
import { buildPackDeck, type DeckTableSlide } from '@/modules/accounting/services/packs/packDeckModel';
import { packSectionTitle } from '@/modules/accounting/services/packs/packSections';
import { buildKPIScorecard } from '@/modules/accounting/services/reports/kpiScorecardService';
import { renderSectionHtml } from '@/../pages/api/accounting/reports-html';

const BASE: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_000,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825.57, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};
const READ = { ...BASE, operatingCashFlow: 345_678.12, investingCashFlow: -98_765.43, financingCashFlow: 12_345.67 };
// `packRatios` takes the engine's `FinancialData`; a pack input carries every
// field it reads, under the same names.
const LABEL = 'Operating Cash Flow Ratio';
const REASON = 'Not stated: no operating cash flow figure was read for this period.';

function ratiosSection(input: ReportPackInput) {
  return buildReportPack('management', input, '2026-03-01', '2026-08-31').sections.find((s) => s.type === 'ratios')!;
}

function printed(input: ReportPackInput) {
  const pack = buildReportPack('management', input, '2026-03-01', '2026-08-31');
  const document = buildPackDocument(pack, []);
  const section = document.sections.find((s) => s.type === 'ratios')!;
  const items = (section.blocks.find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;
  const slide = buildPackDeck(document)
    .find((s): s is DeckTableSlide => s.kind === 'table' && s.title === packSectionTitle('ratios', section.title))!;
  return {
    item: items.find((i) => i.label === LABEL)!,
    deck: slide.rows.find((r) => r.label === LABEL)!.value,
  };
}

describe('the operating cash flow ratio where no cash flow was read', () => {
  it('is null in the section blob and carries its reason', () => {
    const d = ratiosSection(BASE).data as Record<string, unknown> & { notMeaningful: Record<string, string> };
    expect(d.operatingCashFlowRatio).toBeNull();
    expect(d.notMeaningful.operatingCashFlowRatio).toBe(REASON);
    expect(NO_OPERATING_CASH_FLOW_RATIO).toBe(REASON);
  });

  it('prints its reason, not 0.00, in the printed document and the deck', () => {
    const { item, deck } = printed(BASE);
    expect(item.value).toBeNull();
    expect(item.unavailable).toBe(REASON);
    expect(deck).toBe(REASON);
  });

  it('prints its reason in the HTML pack', () => {
    const html = renderSectionHtml(ratiosSection(BASE));
    expect(html).toContain(`<tr><td>Operating Cash Flow Ratio</td><td class="num">${REASON}</td></tr>`);
    expect(html).not.toMatch(/Operating Cash Flow Ratio<\/td><td class="num">0\.00/);
  });

  it('is scored not meaningful, with the reason, by any scorecard target that names it', () => {
    const [row] = buildKPIScorecard(packRatios(BASE), [
      { ratioKey: 'operatingCashFlowRatio', target: 1, warningThreshold: 0.8, criticalThreshold: 0.5, lowerIsBetter: false },
    ]);
    expect(row).toMatchObject({ value: null, status: 'not_meaningful', reason: REASON });
  });
});

describe('the operating cash flow ratio where the cash flow statement was read', () => {
  it('is the measured ratio, everywhere', () => {
    const { item, deck } = printed(READ);
    expect(item.unavailable).toBeUndefined();
    expect(item.value).toBe(0.36);
    expect(deck).toBe('0.36×');
    expect((ratiosSection(READ).data as { notMeaningful: Record<string, string> }).notMeaningful.operatingCashFlowRatio)
      .toBeUndefined();
  });

  it('is scored against a target that names it', () => {
    const [row] = buildKPIScorecard(packRatios(READ), [
      { ratioKey: 'operatingCashFlowRatio', target: 1, warningThreshold: 0.8, criticalThreshold: 0.5, lowerIsBetter: false },
    ]);
    expect(row).toMatchObject({ value: 0.36, status: 'red' });
  });
});
