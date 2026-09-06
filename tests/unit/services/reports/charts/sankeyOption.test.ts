import { describe, it, expect } from 'vitest';
import {
  buildCashFlowSankeyOption, canRenderSankey, type CashFlowReport,
} from '@/components/accounting/charts/sankeyOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const REPORT: CashFlowReport = {
  period_start: '2026-01-01',
  period_end: '2026-08-31',
  opening_cash: 200_000,
  sections: [
    { section: 'Operating Activities', total: 130_000, items: [
      { label: 'Net Income', amount: 180_000 },
      { label: 'Change in Accounts Receivable', amount: -70_000 },
      { label: 'Change in Accounts Payable', amount: 20_000 },
    ] },
    { section: 'Investing Activities', total: -50_000, items: [
      { label: 'Fixed Asset Changes', amount: -50_000 },
    ] },
    { section: 'Financing Activities', total: 0, items: [
      { label: 'Equity Changes', amount: 0 },
    ] },
  ],
  net_change: 80_000,
  closing_cash: 280_000,
};

type Link = { source: string; target: string; value: number };
const linksOf = (o: Record<string, unknown>) =>
  ((o['series'] as Array<{ links: Link[] }>)[0]!).links;
const nodesOf = (o: Record<string, unknown>) =>
  ((o['series'] as Array<{ data: Array<{ name: string }> }>)[0]!).data;

type TooltipOption = { tooltip: { formatter: (p: { name: string; value: number }) => string } };

describe('buildCashFlowSankeyOption', () => {
  const opt = buildCashFlowSankeyOption(REPORT, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('escapes a node name before it reaches the tooltip formatter', () => {
    const malicious: CashFlowReport = {
      ...REPORT,
      sections: [
        { section: 'Operating Activities', total: 0, items: [{ label: '<img src=x onerror=1>', amount: 1_000 }] },
      ],
    };
    const withXss = buildCashFlowSankeyOption(malicious, DEFAULT_PALETTE) as unknown as TooltipOption;
    const html = withXss.tooltip.formatter({ name: '<img src=x onerror=1>', value: 1_000 });
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x onerror=1>');
  });

  it('balances: everything into Cash equals everything out of it', () => {
    const links = linksOf(opt);
    const into = links.filter((l) => l.target === 'Cash').reduce((s, l) => s + l.value, 0);
    const outOf = links.filter((l) => l.source === 'Cash').reduce((s, l) => s + l.value, 0);
    expect(into).toBeCloseTo(outOf, 2);
  });

  it('opens with the opening balance and closes with the closing balance', () => {
    const links = linksOf(opt);
    expect(links.find((l) => l.source === 'Opening cash')?.value).toBe(200_000);
    expect(links.find((l) => l.target === 'Closing cash')?.value).toBe(280_000);
  });

  it('sends outflows out of Cash as positive magnitudes', () => {
    const ar = linksOf(opt).find((l) => l.target === 'Change in Accounts Receivable');
    expect(ar?.source).toBe('Cash');
    expect(ar?.value).toBe(70_000);
  });

  it('drops zero-amount items rather than drawing a zero-width ribbon', () => {
    expect(nodesOf(opt).map((n) => n.name)).not.toContain('Equity Changes');
  });

  it('never uses the favourable or unfavourable colour', () => {
    const json = JSON.stringify(opt);
    expect(json).not.toContain(DEFAULT_PALETTE.fav);
    expect(json).not.toContain(DEFAULT_PALETTE.unfav);
  });
});

describe('canRenderSankey', () => {
  it('accepts a period with positive opening and closing balances', () => {
    expect(canRenderSankey(REPORT)).toBe(true);
  });
  it('refuses an overdrawn closing balance instead of misdrawing it', () => {
    expect(canRenderSankey({ ...REPORT, closing_cash: -10_000 })).toBe(false);
  });
  it('refuses an overdrawn opening balance', () => {
    expect(canRenderSankey({ ...REPORT, opening_cash: -1 })).toBe(false);
  });
  it('refuses a period that moved no cash rather than drawing an empty sankey', () => {
    const nothingHappened: CashFlowReport = {
      ...REPORT,
      opening_cash: 0,
      closing_cash: 0,
      net_change: 0,
      sections: [
        { section: 'Operating Activities', total: 0, items: [{ label: 'Net Income', amount: 0 }] },
      ],
    };
    // Every sign test passes; the builder would still return a series with
    // no links, which ECharts renders as a blank panel.
    expect(nothingHappened.opening_cash >= 0 && nothingHappened.closing_cash >= 0).toBe(true);
    const links = linksOf(
      buildCashFlowSankeyOption(nothingHappened, DEFAULT_PALETTE) as unknown as Record<string, unknown>,
    );
    expect(links).toHaveLength(0);

    expect(canRenderSankey(nothingHappened)).toBe(false);
  });
  it('still draws a zero-balance period that moved cash within it', () => {
    const movedAndReturned: CashFlowReport = {
      ...REPORT,
      opening_cash: 0,
      closing_cash: 0,
      net_change: 0,
      sections: [
        { section: 'Operating Activities', total: 0, items: [
          { label: 'Net Income', amount: 50_000 },
          { label: 'Fixed Asset Changes', amount: -50_000 },
        ] },
      ],
    };
    expect(canRenderSankey(movedAndReturned)).toBe(true);
  });
});
