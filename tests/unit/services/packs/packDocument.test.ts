import { describe, it, expect } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { buildPackDocument, RATIO_FORMATS, UnknownPackSectionError, type PackKvItem } from '@/modules/accounting/services/packs/packDocument';
import { MissingPackFieldError } from '@/modules/accounting/services/packs/packSectionData';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

const INPUT: ReportPackInput = {
  companyName: 'ISAFlow Demo', period: '2026-01-01 to 2026-09-05',
  revenue: 4812345.67, costOfSales: 2190000, operatingExpenses: 1400000, netProfit: 1275632.74,
  totalAssets: 8200000, totalLiabilities: 3100000, totalEquity: 5100000,
  currentAssets: 4400000, currentLiabilities: 1900000, cash: 1250000,
  accountsReceivable: 2100000, accountsPayable: 900000, inventory: 350000,
  otherIncome: 53787.07, otherExpenses: 0, operatingProfit: 1275632.74,
};

const TREND: PackTrendPoint[] = [
  {
    month: '2026-08', label: 'Aug 2026', revenue: 400000, expenses: 300000, netProfit: 100000,
    costOfSales: 180000, operatingExpenses: 120000, grossMarginPct: 55,
    cash: 250000, accountsReceivable: 90000, debtorDays: 6.75,
  },
  {
    month: '2026-09', label: 'Sep 2026', revenue: 420000, expenses: 310000, netProfit: 110000,
    costOfSales: 185000, operatingExpenses: 125000, grossMarginPct: 55.95,
    cash: 260000, accountsReceivable: 95000, debtorDays: 6.79,
  },
];

const pack = buildReportPack('management', INPUT, '2026-01-01', '2026-09-05');

/** Every number reachable in a value, however deeply nested. */
function numbersIn(value: unknown, found: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number') { found.add(Math.round(value * 100) / 100); return found; }
  if (Array.isArray(value)) { value.forEach((v) => numbersIn(v, found)); return found; }
  if (value && typeof value === 'object') { Object.values(value).forEach((v) => numbersIn(v, found)); return found; }
  return found;
}

describe('buildPackDocument', () => {
  it('carries every section the pack has, in order, under its IFRS title', () => {
    const doc = buildPackDocument(pack, TREND);
    expect(doc.sections.map((s) => s.type)).toEqual(pack.sections.map((s) => s.type));
    expect(doc.sections[0]!.title).toBe('Statement of Comprehensive Income');
  });

  it('turns only the chart sections landscape', () => {
    const doc = buildPackDocument(pack, TREND);
    const landscape = doc.sections.filter((s) => s.landscape).map((s) => s.type);
    expect(landscape).toEqual(['waterfall', 'trends']);
  });

  it('INVENTS NO FIGURE: every number in the document is a pack number', () => {
    const doc = buildPackDocument(pack, TREND);
    const allowed = numbersIn(pack.sections.map((s) => s.data));
    numbersIn(TREND).forEach((n) => allowed.add(n));
    // The one documented exception, inherited from ManagementBalanceSheetRows:
    // the report has no Total Liabilities and Equity field, so the row sums the
    // two subtotals. Nothing else may be derived.
    allowed.add(Math.round((INPUT.totalLiabilities + INPUT.totalEquity) * 100) / 100);
    // Row depths and chart geometry are structure, not figures.
    [0, 1].forEach((n) => allowed.add(n));

    const unexplained = [...numbersIn(doc.sections)].filter((n) => !allowed.has(n));
    expect(unexplained).toEqual([]);
  });

  it('keeps the P&L bands the pack service produced, bottom line included', () => {
    const doc = buildPackDocument(pack, TREND);
    const is = doc.sections.find((s) => s.type === 'income_statement')!;
    const rows = (is.blocks.find((b) => b.kind === 'statement') as { rows: Array<{ id: string; actual: number }> }).rows;
    expect(rows.find((r) => r.id === 'grand:netProfit')!.actual).toBe(INPUT.netProfit);
    expect(rows.map((r) => r.id)).toContain('total:operatingProfit');
  });

  it('plots the trend series it was handed, not the pack single-period snapshot', () => {
    const doc = buildPackDocument(pack, TREND);
    const trends = doc.sections.find((s) => s.type === 'trends')!;
    const block = trends.blocks.find((b) => b.kind === 'trend') as { points: PackTrendPoint[] };
    expect(block.points).toEqual(TREND);
  });

  it('renders an empty trend series as a text block rather than an empty chart', () => {
    const doc = buildPackDocument(pack, []);
    const trends = doc.sections.find((s) => s.type === 'trends')!;
    expect(trends.blocks.some((b) => b.kind === 'text')).toBe(true);
    expect(trends.blocks.some((b) => b.kind === 'trend')).toBe(false);
  });

  it('tags each ratio field with the unit it is actually in, not all as ratios', () => {
    const doc = buildPackDocument(pack, TREND);
    const ratios = doc.sections.find((s) => s.type === 'ratios')!;
    const items = (ratios.blocks.find((b) => b.kind === 'kv') as { items: Array<{ label: string; value: number; format: string }> }).items;

    // A rand amount printed as a bare ratio is the defect this map exists for.
    expect(items.find((i) => i.label === 'Working Capital')!.format).toBe('money');
    expect(items.find((i) => i.label === 'Free Cash Flow')!.format).toBe('money');
    expect(items.find((i) => i.label === 'Ebitda Margin')!.format).toBe('pct');
    expect(items.find((i) => i.label === 'Roce')!.format).toBe('pct');
    expect(items.find((i) => i.label === 'Current Ratio')!.format).toBe('ratio');
    expect(items.find((i) => i.label === 'Debt Ratio')!.format).toBe('ratio');
    expect(new Set(items.map((i) => i.format))).toEqual(new Set(['money', 'pct', 'ratio', 'days']));
  });

  it('has a format for every numeric field calculateExtendedRatios returns', () => {
    // The `satisfies Record<RatioKey, …>` on RATIO_FORMATS makes a NEW field a
    // compile error; this proves the shipped map matches what the service
    // actually emits at runtime, so no ratio can reach a pack untagged.
    const ratios = calculateExtendedRatios({
      revenue: 4812345.67, costOfSales: 2190000, operatingExpenses: 1400000, netProfit: 1275632.74,
      totalAssets: 8200000, totalLiabilities: 3100000, totalEquity: 5100000,
      currentAssets: 4400000, currentLiabilities: 1900000, cash: 1250000,
      accountsReceivable: 2100000, accountsPayable: 900000, inventory: 350000,
      depreciation: 120000, amortization: 30000, interestExpense: 45000, interestIncome: 5000,
      operatingCashFlow: 1400000, capitalExpenditure: 200000, employeeCount: 25,
      employeeCosts: 900000, directMaterialCosts: 1800000, taxExpense: 300000, dividendsPaid: 200000,
    });
    const numericKeys = Object.entries(ratios).filter(([, v]) => typeof v === 'number').map(([k]) => k);
    const untagged = numericKeys.filter((k) => !(k in RATIO_FORMATS));
    expect(untagged).toEqual([]);
    expect(numericKeys.length).toBeGreaterThan(30);
  });

  /**
   * ADVERSARIAL MEDIUM-1: the cash-flow section was read by string key through
   * a `num()` that returned 0 for a missing one, so a rename in
   * `reportPackService` produced six labelled zeros — a plausible statement of
   * nothing, with no compile error. The structural "INVENTS NO FIGURE" test
   * above cannot catch it: 0 is in the pack's own number set.
   */
  describe('the cash-flow section', () => {
    const cashFlowItems = (doc: ReturnType<typeof buildPackDocument>) => {
      const section = doc.sections.find((s) => s.type === 'cash_flow')!;
      return (section.blocks.find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;
    };

    it('prints each line under its own label, with the figure the service produced', () => {
      const source = pack.sections.find((s) => s.type === 'cash_flow')!.data as Record<string, number>;
      const items = cashFlowItems(buildPackDocument(pack, TREND));

      expect(items.map((i) => i.label)).toEqual([
        'Operating Cash Flow', 'Investing Cash Flow', 'Financing Cash Flow',
        'Net Cash Flow', 'Opening Cash', 'Closing Cash',
      ]);
      expect(items.map((i) => i.value)).toEqual([
        source.operatingCashFlow, source.investingCashFlow, source.financingCashFlow,
        source.netCashFlow, source.openingCash, source.closingCash,
      ]);
      // Not all zero — a document of zeros would satisfy the labels alone.
      expect(items.some((i) => i.value !== 0)).toBe(true);
      expect(items.every((i) => i.format === 'money')).toBe(true);
    });

    it('throws rather than printing a zero when a field is renamed upstream', () => {
      const renamed = {
        ...pack,
        sections: pack.sections.map((s) => (s.type !== 'cash_flow' ? s : {
          ...s,
          // Exactly what a rename looks like from here: the value is still in
          // the blob, under a name this file does not read.
          data: { ...s.data, operatingCashFlow: undefined, operating_cash_flow: s.data.operatingCashFlow },
        })),
      };
      expect(() => buildPackDocument(renamed, TREND)).toThrow(MissingPackFieldError);
      expect(() => buildPackDocument(renamed, TREND)).toThrow(/operatingCashFlow/);
    });
  });

  it.each([
    ['kpis', 'scorecard'],
    ['waterfall', 'steps'],
    ['commentary', 'summary'],
    ['ratios', 'notMeaningful'],
  ])('throws when the %s section loses its %s field', (sectionType, field) => {
    const stripped = {
      ...pack,
      sections: pack.sections.map((s) => (s.type !== sectionType ? s : { ...s, data: { ...s.data, [field]: undefined } })),
    };
    expect(() => buildPackDocument(stripped, TREND)).toThrow(MissingPackFieldError);
    expect(() => buildPackDocument(stripped, TREND)).toThrow(new RegExp(field));
  });

  it('throws on a section type it has no blocks for rather than printing a blank page', () => {
    const withStranger = { ...pack, sections: [...pack.sections, { type: 'segments', title: 'Segments', data: {} }] };
    expect(() => buildPackDocument(withStranger, TREND)).toThrow(UnknownPackSectionError);
    expect(() => buildPackDocument(withStranger, TREND)).toThrow(/segments/);
  });

  it('tags the day counts as days, not as ratios', () => {
    const doc = buildPackDocument(pack, TREND);
    const ratios = doc.sections.find((s) => s.type === 'ratios')!;
    const items = (ratios.blocks.find((b) => b.kind === 'kv') as { items: Array<{ label: string; format: string }> }).items;
    for (const label of ['Debtor Days', 'Creditor Days', 'Inventory Days', 'Cash Conversion Cycle']) {
      expect(items.find((i) => i.label === label)!.format).toBe('days');
    }
  });

  it('prints a not-meaningful ratio with its reason rather than dropping the row', () => {
    // Negative equity: every equity-divided ratio is arithmetically meaningless
    // (AN-07). The dashboard shows the reason; the pack must not show nothing.
    const insolvent = buildReportPack('management', { ...INPUT, totalEquity: -250000 }, '2026-01-01', '2026-09-05');
    const doc = buildPackDocument(insolvent, TREND);
    const ratios = doc.sections.find((s) => s.type === 'ratios')!;
    const items = (ratios.blocks.find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;

    for (const label of ['Debt To Equity', 'Return On Equity', 'Equity Multiplier', 'Dupont Leverage']) {
      const item = items.find((i) => i.label === label);
      expect(item, `${label} must still appear`).toBeDefined();
      expect(item!.value).toBeNull();
      expect(item!.unavailable).toMatch(/liabilities exceed assets/);
    }

    // A ratio that IS computable keeps its figure and carries no reason.
    const current = items.find((i) => i.label === 'Current Ratio')!;
    expect(typeof current.value).toBe('number');
    expect(current.unavailable).toBeUndefined();
  });

  it('carries no unavailable reason when equity is sound', () => {
    const doc = buildPackDocument(pack, TREND);
    const ratios = doc.sections.find((s) => s.type === 'ratios')!;
    const items = (ratios.blocks.find((b) => b.kind === 'kv') as { items: PackKvItem[] }).items;
    expect(items.filter((i) => i.unavailable !== undefined)).toEqual([]);
    expect(items.filter((i) => i.value === null)).toEqual([]);
  });
});