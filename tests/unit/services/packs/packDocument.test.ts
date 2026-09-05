import { describe, it, expect } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { buildPackDocument } from '@/modules/accounting/services/packs/packDocument';
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
  { month: '2026-08', label: 'Aug 2026', revenue: 400000, expenses: 300000, netProfit: 100000 },
  { month: '2026-09', label: 'Sep 2026', revenue: 420000, expenses: 310000, netProfit: 110000 },
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
});
