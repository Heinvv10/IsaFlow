/**
 * A FIGURE THE PACK CANNOT STATE PRINTS ITS REASON, NOT A STAND-IN.
 *
 * Two stand-ins lived in the report pack's sections:
 *
 *   - "Free Cash Flow" is operating cash flow less capital expenditure, and
 *     nothing carries capital expenditure: the cash flow statement nets
 *     acquisitions against disposals. It printed 0 while operating cash flow
 *     was absent too, and would have printed operating cash flow under the
 *     name "free cash flow" the moment that figure arrived.
 *   - The cash flow section took operating cash flow to BE net profit where
 *     none was carried, investing and financing to be nil, and derived an
 *     opening balance from the three.
 *
 * Read through both printed surfaces: the PDF's section model and the deck.
 */
import { describe, expect, it } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { buildPackDocument, type PackKvItem } from '@/modules/accounting/services/packs/packDocument';
import { buildPackDeck, type DeckTableSlide } from '@/modules/accounting/services/packs/packDeckModel';
import { packSectionTitle } from '@/modules/accounting/services/packs/packSections';

const BASE: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_000,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825.57, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};
const FLOWS = { operatingCashFlow: 345_678.12, investingCashFlow: -98_765.43, financingCashFlow: 12_345.67 };

function printed(input: ReportPackInput, sectionType: 'ratios' | 'cash_flow') {
  const document = buildPackDocument(buildReportPack('management', input, '2026-03-01', '2026-08-31'), []);
  const section = document.sections.find((s) => s.type === sectionType)!;
  const items = (section.blocks.find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;
  const slide = buildPackDeck(document)
    .find((s): s is DeckTableSlide => s.kind === 'table' && s.title === packSectionTitle(sectionType, section.title))!;
  return {
    item: (label: string) => items.find((i) => i.label === label)!,
    deck: (label: string) => slide.rows.find((r) => r.label === label)!.value,
  };
}

const NO_CAPEX = /capital expenditure is not captured separately/i;

describe('free cash flow in the report pack', () => {
  it('prints a reason, not operating cash flow, where no capital expenditure is carried', () => {
    const { item, deck } = printed({ ...BASE, ...FLOWS }, 'ratios');
    expect(item('Free Cash Flow').value).toBeNull();
    expect(item('Free Cash Flow').unavailable).toMatch(NO_CAPEX);
    expect(deck('Free Cash Flow')).toMatch(NO_CAPEX);
    expect(deck('Free Cash Flow')).not.toMatch(/345/);
  });

  it('prints a reason rather than nil where neither figure is carried', () => {
    const { item, deck } = printed(BASE, 'ratios');
    expect(item('Free Cash Flow').value).toBeNull();
    expect(deck('Free Cash Flow')).toMatch(NO_CAPEX);
  });

  it('prints operating less capital expenditure where capital expenditure is carried', () => {
    const { item, deck } = printed({ ...BASE, ...FLOWS, capitalExpenditure: 150_000 }, 'ratios');
    expect(item('Free Cash Flow').unavailable).toBeUndefined();
    expect(item('Free Cash Flow').value).toBe(195_678.12);
    expect(deck('Free Cash Flow')).toMatch(/195.678[.,]12/);
  });

  it('leaves the operating cash flow ratio on the real operating figure', () => {
    const { item } = printed({ ...BASE, ...FLOWS }, 'ratios');
    expect(item('Operating Cash Flow Ratio').value).toBe(0.36);
    expect(item('Operating Cash Flow Ratio').unavailable).toBeUndefined();
  });
});

const NOT_READ = /no .*cash flow figure was read for this period/i;

describe('the cash flow section where no cash flow statement was read', () => {
  it('does not print net profit as operating cash flow, in the PDF model or the deck', () => {
    const { item, deck } = printed(BASE, 'cash_flow');
    expect(item('Operating Cash Flow').value).toBeNull();
    expect(item('Operating Cash Flow').unavailable).toMatch(NOT_READ);
    expect(deck('Operating Cash Flow')).toMatch(NOT_READ);
    expect(deck('Operating Cash Flow')).not.toMatch(/480/);
  });

  it('does not print investing or financing as nil, or a net and an opening balance derived from them', () => {
    const { item } = printed(BASE, 'cash_flow');
    const DEPENDS = 'Not stated: it depends on a cash flow figure that was not read for this period.';
    for (const [label, reason] of [
      ['Investing Cash Flow', 'No investing cash flow figure was read for this period.'],
      ['Financing Cash Flow', 'No financing cash flow figure was read for this period.'],
      ['Net Cash Flow', DEPENDS],
      ['Opening Cash', DEPENDS],
    ] as const) {
      expect(item(label).value, label).toBeNull();
      expect(item(label).unavailable, label).toBe(reason);
    }
  });

  it('still prints closing cash, which is a balance and not a flow', () => {
    const { item } = printed(BASE, 'cash_flow');
    expect(item('Closing Cash').value).toBe(2_046_825.57);
    expect(item('Closing Cash').unavailable).toBeUndefined();
  });

  it('prints all six figures where the three flows are carried', () => {
    const { item, deck } = printed({ ...BASE, ...FLOWS }, 'cash_flow');
    for (const label of ['Operating Cash Flow', 'Investing Cash Flow', 'Financing Cash Flow', 'Net Cash Flow', 'Opening Cash', 'Closing Cash']) {
      expect(item(label).unavailable, label).toBeUndefined();
      expect(item(label).value, label).not.toBeNull();
    }
    expect(item('Investing Cash Flow').value).toBe(-98_765.43);
    expect(deck('Operating Cash Flow')).toMatch(/345.678[.,]12/);
  });

  it('withholds only what depends on the missing figure when one flow is absent', () => {
    const { item } = printed({ ...BASE, operatingCashFlow: 345_678.12, capitalExpenditure: 150_000 }, 'cash_flow');
    expect(item('Operating Cash Flow').value).toBe(345_678.12);
    expect(item('Investing Cash Flow').value).toBe(-150_000);
    expect(item('Financing Cash Flow').value).toBeNull();
    expect(item('Net Cash Flow').value).toBeNull();
    expect(item('Opening Cash').value).toBeNull();
  });
});
