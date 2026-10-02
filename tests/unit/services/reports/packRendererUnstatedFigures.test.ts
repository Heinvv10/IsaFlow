/**
 * THE TWO LEGACY PACK RENDERERS PRINT A REASON WHERE THE PACK HAS NO FIGURE.
 *
 * `reports-pdf.ts` and `reports-html.ts` read the pack's section blobs
 * directly. The cash flow section still carries six numbers for them, three
 * of which are stand-ins when no cash flow statement was read — net profit as
 * operating cash flow, nil as investing and financing — and the section says
 * so in its `unavailable` map, which neither renderer looked at. The ratios
 * table dropped any null ratio without a word, and printed the reasons map
 * itself as a row reading "[object Object]".
 *
 * Driven through the real section renderers, on sections the real pack
 * service built.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn(), error: vi.fn() } }));

import { renderSectionHtml } from '@/../pages/api/accounting/reports-html';
import { renderSection } from '@/../pages/api/accounting/reports-pdf';
import { buildReportPack, type PackSection, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { ratioLabel } from '@/modules/accounting/services/reports/ratioPresentation';

const BASE: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_000,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825.57, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};
const FLOWS = { operatingCashFlow: 345_678.12, investingCashFlow: -98_765.43, financingCashFlow: 12_345.67 };

function section(input: ReportPackInput, type: 'cash_flow' | 'ratios'): PackSection {
  return buildReportPack('management', input, '2026-03-01', '2026-08-31').sections.find((s) => s.type === type)!;
}

/** label → value cell, as the PDF renderer hands its rows to autoTable. */
function pdfRows(s: PackSection): Map<string, string> {
  const calls: Array<{ body: string[][] }> = [];
  const autoTable = (_d: unknown, o: { body: string[][] }) => { calls.push(o); };
  const doc = {
    lastAutoTable: { finalY: 20 }, setFontSize: () => {}, setFont: () => {},
    setTextColor: () => {}, text: () => {}, addPage: () => {}, setFillColor: () => {}, rect: () => {},
  } as never;
  renderSection(doc, autoTable, s, 210, 297, 10, { r: 0, g: 0, b: 0 });
  return new Map(calls[0]!.body.map((r) => [r[0]!, r[1]!]));
}

/** label → value cell, read back out of the HTML renderer's table. */
function htmlRows(s: PackSection): Map<string, string> {
  const rows = [...renderSectionHtml(s).matchAll(/<tr><td>(.*?)<\/td><td[^>]*>(.*?)<\/td><\/tr>/g)];
  return new Map(rows.map((m) => [m[1]!, m[2]!]));
}

const RENDERERS: Array<[string, (s: PackSection) => Map<string, string>]> = [
  ['the PDF pack', pdfRows],
  ['the HTML pack', htmlRows],
];

describe.each(RENDERERS)('%s — cash flow section with no statement read', (_name, rows) => {
  const cells = rows(section(BASE, 'cash_flow'));

  it('prints a reason, not net profit, as operating cash flow', () => {
    expect(cells.get('Operating Cash Flow')).toBe('No operating cash flow figure was read for this period.');
    expect([...cells.values()].join('|')).not.toMatch(/480[ , ]?000/);
  });

  it('prints a reason on every line that depends on a figure nobody read', () => {
    for (const label of ['Investing Cash Flow', 'Financing Cash Flow', 'Net Cash Flow', 'Opening Cash']) {
      expect(cells.get(label), label).toMatch(/not read for this period|was read for this period/);
      expect(cells.get(label), label).not.toMatch(/^R\s/);
    }
  });

  it('still prints closing cash as money', () => {
    expect(cells.get('Closing Cash')).toMatch(/^R\s/);
    expect(cells.get('Closing Cash')).toMatch(/2.046.825[.,]57/);
  });

  it('keeps all six rows', () => {
    expect([...cells.keys()]).toEqual([
      'Operating Cash Flow', 'Investing Cash Flow', 'Financing Cash Flow',
      'Net Cash Flow', 'Opening Cash', 'Closing Cash',
    ]);
  });
});

describe.each(RENDERERS)('%s — cash flow section with the statement read', (_name, rows) => {
  const cells = rows(section({ ...BASE, ...FLOWS }, 'cash_flow'));

  it('prints all six as money', () => {
    for (const [label, value] of cells) expect(value, label).toMatch(/^R\s/);
    expect(cells.get('Operating Cash Flow')).toMatch(/345.678[.,]12/);
    expect(cells.get('Investing Cash Flow')).toMatch(/98.765[.,]43/);
  });
});

describe.each(RENDERERS)('%s — ratios', (_name, rows) => {
  it('prints free cash flow with its reason where capital expenditure is not carried', () => {
    const cells = rows(section({ ...BASE, ...FLOWS }, 'ratios'));
    expect(cells.get('Free Cash Flow')).toMatch(/capital expenditure is not captured separately/i);
  });

  it('prints no reason for free cash flow where capital expenditure is carried', () => {
    const cells = rows(section({ ...BASE, ...FLOWS, capitalExpenditure: 150_000 }, 'ratios'));
    expect([...cells.values()].join('|')).not.toMatch(/capital expenditure is not captured/i);
  });

  it('prints an equity ratio with its reason on negative equity, rather than dropping the row', () => {
    const cells = rows(section({ ...BASE, totalEquity: -500_000, totalLiabilities: 4_400_000 }, 'ratios'));
    expect(cells.get('Debt to Equity')).toMatch(/negative/i);
  });

  it('does not print the reasons map as a ratio of its own', () => {
    const cells = rows(section({ ...BASE, ...FLOWS }, 'ratios'));
    expect([...cells.keys()].filter((k) => /meaningful/i.test(k))).toEqual([]);
    expect([...cells.values()].join('|')).not.toContain('[object Object]');
  });

  it('still prints the ordinary ratios as numbers', () => {
    const cells = rows(section({ ...BASE, ...FLOWS }, 'ratios'));
    expect(cells.get('Current Ratio')).toBe('2.00×');
    // In its unit: a margin is a percentage, a turnover a multiple.
    // A level, so unsigned: a gross margin of 45% did not rise by 45%.
    expect(cells.get('Gross Profit Margin')).toBe('45.0%');
    expect(cells.get('Inventory Turnover')).toBe('7.45×');
  });
});

describe('the PDF pack — ratios', () => {
  it('prints operating less capital expenditure as free cash flow', () => {
    const cells = pdfRows(section({ ...BASE, ...FLOWS, capitalExpenditure: 150_000 }, 'ratios'));
    // A rand amount, grouped — not "195678.12".
    expect(cells.get('Free Cash Flow')).toBe('195\u00a0678.12');
  });
});

/**
 * THE HTML PACK PRINTS TWENTY RATIOS WITH FIGURES, THEN EVERY RATIO WITHOUT.
 *
 * It printed the first twenty entries. Keeping the rows that carry a reason
 * was done as `index < 20 || no figure`, which counts a reasoned row among
 * the twenty — so each ratio that lost its figure pushed a ratio that HAD one
 * off the end of the table. Which numeric ratios print must not depend on how
 * many others could not be computed.
 */
describe('the HTML pack — which ratios print', () => {
  /** The labels of the section's ratios that have a figure, in order. */
  function figured(s: PackSection): string[] {
    const reasons = (s.data as { notMeaningful: Record<string, string> }).notMeaningful;
    return Object.entries(s.data)
      .filter(([k, v]) => typeof v === 'number' && reasons[k] === undefined)
      .map(([k]) => ratioLabel(k));
  }
  const SOUND = { ...BASE, ...FLOWS };
  const INSOLVENT = { ...SOUND, totalEquity: -500_000, totalLiabilities: 4_400_000 };

  it('prints the first twenty ratios that have figures, however many others have none', () => {
    const s = section(INSOLVENT, 'ratios');
    const reasons = Object.keys((s.data as { notMeaningful: Record<string, string> }).notMeaningful);
    // The premise: on negative equity several ratios inside the first twenty
    // entries have no figure.
    const firstTwentyKeys = Object.keys(s.data).slice(0, 20);
    expect(firstTwentyKeys.filter((k) => reasons.includes(k)).length).toBeGreaterThanOrEqual(2);

    const printed = [...htmlRows(s).keys()];
    const expected = figured(s).slice(0, 20);
    expect(expected).toHaveLength(20);
    expect(printed.slice(0, 20)).toEqual(expected);
  });

  it('prints every ratio without a figure after them, each with its reason', () => {
    const s = section(INSOLVENT, 'ratios');
    const reasons = (s.data as { notMeaningful: Record<string, string> }).notMeaningful;
    const cells = htmlRows(s);
    const tail = [...cells.keys()].slice(20);
    expect(tail).toEqual(Object.keys(s.data)
      .filter((k) => reasons[k] !== undefined)
      .map((k) => ratioLabel(k)));
    for (const label of tail) expect(cells.get(label), label).toMatch(/[a-z]{5,}/);
  });

  it('leaves a free cash flow that has a figure outside the twenty, as it always was', () => {
    const cells = htmlRows(section({ ...SOUND, capitalExpenditure: 150_000 }, 'ratios'));
    // Twenty rows carry a figure; the rest are ratios with a reason.
    expect([...cells.values()].filter((v) => !/[a-z]{5,}/.test(v))).toHaveLength(20);
    expect(cells.has('Free Cash Flow')).toBe(false);
  });
});
