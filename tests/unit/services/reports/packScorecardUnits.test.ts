/**
 * A KPI TILE PRINTS ITS FIGURE AND ITS TARGET IN THE RATIO'S OWN UNIT.
 *
 * The management pack's KPI Scorecard (page 8 of the demo pack) printed
 * "(1 310.83) / 35", "(1 522.92) / 15", "213.23 / 30" and "(0.14) / 1.5": no
 * %, no days, two decimals on a margin and a day count — the same ratios the
 * Financial Ratios page two sheets earlier printed as "(1 310.8%)" and
 * "213 days". The legacy PDF and HTML packs printed `toFixed(2)` too, and the
 * HTML pack wrote "null" where a ratio had no value.
 *
 * Value and target now both go through `ratioPresentation`, and a ratio the
 * engine did not state prints its reason instead of a number scored against
 * a target. Driven through the real pack service and every renderer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn(), error: vi.fn() } }));

import { renderSectionHtml } from '@/../pages/api/accounting/reports-html';
import { renderSection } from '@/../pages/api/accounting/reports-pdf';
import { buildReportPack, type PackSection, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import { formatScorecardValue, scorecardFigure } from '@/modules/accounting/services/packs/packKvFormat';

/** The demo pack's shape: a sliver of revenue under a large cost base, and negative equity. */
const DEMO: ReportPackInput = {
  companyName: 'Demo', period: '2026-01-01 to 2026-09-07',
  revenue: 100_000, costOfSales: 1_400_000, operatingExpenses: 200_000, netProfit: -1_500_000,
  totalAssets: 900_000, totalLiabilities: 1_300_000, totalEquity: -400_000,
  currentAssets: 140_000, currentLiabilities: 1_000_000,
  cash: 20_000, accountsReceivable: 58_000, accountsPayable: 300_000, inventory: 0,
};
/** Brightsphere's: credit notes exceeding sales. */
const BRIGHTSPHERE: ReportPackInput = { ...DEMO, revenue: -5_535_000, costOfSales: 0, netProfit: -6_400_000, accountsReceivable: 0 };

const plain = (s: string): string => s.replace(/[  ]/g, ' ');

function kpis(input: ReportPackInput): { section: PackSection; items: KPIScorecardItem[] } {
  const section = buildReportPack('management', input, '2026-01-01', '2026-09-07').sections.find((s) => s.type === 'kpis')!;
  return { section, items: (section.data as { scorecard: KPIScorecardItem[] }).scorecard };
}

/** KPI name → [actual cell, target cell], from each legacy renderer. */
function pdfCells(s: PackSection): Map<string, [string, string]> {
  const calls: Array<{ body: string[][] }> = [];
  const autoTable = (_d: unknown, o: { body: string[][] }) => { calls.push(o); };
  const doc = {
    lastAutoTable: { finalY: 20 }, setFontSize: () => {}, setFont: () => {},
    setTextColor: () => {}, text: () => {}, addPage: () => {}, setFillColor: () => {}, rect: () => {},
  } as never;
  renderSection(doc, autoTable, s, 210, 297, 10, { r: 0, g: 0, b: 0 });
  return new Map(calls[0]!.body.map((r) => [r[0]!, [plain(r[1]!), plain(r[2]!)]]));
}
function htmlCells(s: PackSection): Map<string, [string, string]> {
  const rows = [...renderSectionHtml(s).matchAll(/<tr><td>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td>/g)];
  return new Map(rows.map((m) => [m[1]!, [plain(m[2]!), plain(m[3]!)]]));
}

const DEMO_TILES: Array<[string, string, string]> = [
  ['Gross Profit Margin', '(1 300.0%)', '35.0%'],
  ['Net Profit Margin', '(1 500.0%)', '15.0%'],
  ['Current Ratio', '0.14×', '1.50×'],
  ['Debtor Days', '212 days', '30 days'],
];

describe('the pack document\'s tile (screen, print view, deck)', () => {
  const { items } = kpis(DEMO);
  const byName = new Map(items.map((i) => [i.name, i]));

  it.each(DEMO_TILES)('%s prints %s against a target of %s', (name, value, target) => {
    const figure = scorecardFigure(byName.get(name)!);
    expect(figure.scored).toBe(true);
    if (!figure.scored) return;
    expect(plain(figure.value)).toBe(value);
    expect(plain(figure.target)).toBe(target);
    expect(plain(formatScorecardValue(byName.get(name)!))).toBe(`${value} / ${target}`);
  });

  it('prints the reason for a ratio the engine did not state, and no target score', () => {
    const figure = scorecardFigure(byName.get('Debt to Equity')!);
    expect(figure).toMatchObject({ scored: false, reason: expect.stringMatching(/^Equity is negative/) });
  });
});

describe('on Brightsphere\'s negative revenue', () => {
  const { items } = kpis(BRIGHTSPHERE);

  it.each(['Gross Profit Margin', 'Net Profit Margin', 'Debtor Days'])('%s is not scored: it prints the reason', (name) => {
    const item = items.find((i) => i.name === name)!;
    expect(item.status).toBe('not_meaningful');
    expect(scorecardFigure(item)).toEqual({
      scored: false, reason: 'Revenue is not positive, so this ratio has no meaning.', target: expect.any(String),
    });
  });
});

describe.each([['the legacy PDF pack', pdfCells], ['the legacy HTML pack', htmlCells]])('%s', (_name, cells) => {
  it.each(DEMO_TILES)('prints %s as %s against %s', (name, value, target) => {
    expect(cells(kpis(DEMO).section).get(name)).toEqual([value, target]);
  });

  it('prints the reason, not "null" or a dash, where a ratio has no value', () => {
    const [actual, target] = cells(kpis(BRIGHTSPHERE).section).get('Gross Profit Margin')!;
    expect(actual).toBe('Revenue is not positive, so this ratio has no meaning.');
    expect(target).toBe('35.0%');
  });
});
