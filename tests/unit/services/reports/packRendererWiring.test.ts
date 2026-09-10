/**
 * The WIRING between the shared row list and the two client-facing packs.
 *
 * `incomeStatementPackRows` is tested, but that does not protect these: a
 * `.filter()` added here, or a dropped table cell, leaves the list correct and
 * the document wrong. Both renderers were unexported and therefore unreachable
 * from any test, so deleting a row from either stayed green — the exact bug
 * class that put a P&L short by R341,712.00 on a PDF sent to a client.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn(), error: vi.fn() } }));

import { renderSectionHtml } from '@/../pages/api/accounting/reports-html';
import { renderSection } from '@/../pages/api/accounting/reports-pdf';
import { NO_MARGIN_CELL } from '@/modules/accounting/services/reports/incomeStatementPackRows';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';

/** Brightsphere, all-time — the tenant whose pack was short by R341,712.00. */
const SECTION = {
  type: 'income_statement',
  title: 'Income Statement',
  data: {
    revenue: 13485163.41, costOfSales: 0, grossProfit: 13485163.41,
    otherIncome: 23323.42, operatingExpenses: 4748602.81,
    operatingProfit: 8759884.02, otherExpenses: 365035.42,
    netProfit: 8394848.60, grossMargin: 100, netMargin: 62.25,
  },
} as never;

const BANDS = [
  'Turnover', 'Cost of Sales', 'Gross Profit', 'Other Income',
  'Operating Expenses', 'Operating Profit', 'Other Expenses', 'Net Profit',
];

const BALANCE_SHEET = {
  type: 'balance_sheet',
  title: 'Balance Sheet',
  data: {
    currentAssets: 300, totalAssets: 500, cash: 100, accountsReceivable: 200,
    totalEquity: 300, currentLiabilities: 150, totalLiabilities: 200, accountsPayable: 125,
  },
} as never;

const BALANCE_SHEET_ROWS = [
  'Total Assets', 'Current Assets', 'Cash', 'Accounts Receivable',
  'Total Equity', 'Total Liabilities', 'Accounts Payable',
  'Total Equity and Liabilities',
];

describe('HTML pack renderer', () => {
  it('emits every band', () => {
    const html = renderSectionHtml(SECTION);
    for (const b of BANDS) expect(html, b).toContain(b);
  });

  it('emits them in reconciling order', () => {
    const html = renderSectionHtml(SECTION);
    const at = (b: string) => html.indexOf(`<td>${b}</td>`);
    for (const b of BANDS) expect(at(b), b).toBeGreaterThan(-1);
    const positions = BANDS.map(at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('renders a margin only on the two rows that carry one', () => {
    const html = renderSectionHtml(SECTION);
    expect(html).toMatch(/100\.0%/);
    expect(html).toMatch(/62\.3%|62\.25%/);
    // Not NaN%: the margin is a number, and each pack formats it once.
    expect(html).not.toContain('NaN');
  });

  it('gives every row three cells, so no column shifts', () => {
    const html = renderSectionHtml(SECTION);
    // Body rows only — the header row uses <th>.
    const rows = (html.match(/<tr>.*?<\/tr>/g) ?? []).filter(r => r.includes('<td'));
    expect(rows.length).toBe(BANDS.length);
    for (const r of rows) {
      expect((r.match(/<td/g) ?? []).length, r).toBe(3);
    }
  });

  it('renders the balance sheet Equity before Liabilities with the combined total', () => {
    const html = renderSectionHtml(BALANCE_SHEET);
    const positions = BALANCE_SHEET_ROWS.map(label => html.indexOf(`<td>${label}</td>`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('PDF pack renderer', () => {
  /** Capture what the renderer hands to autoTable. */
  const capture = () => {
    const calls: Array<{ head: unknown; body: string[][] }> = [];
    const autoTable = (_doc: unknown, opts: { head: unknown; body: string[][] }) => {
      calls.push({ head: opts.head, body: opts.body });
    };
    const doc = {
      lastAutoTable: { finalY: 20 },
      setFontSize: () => {}, setFont: () => {}, setTextColor: () => {},
      text: () => {}, addPage: () => {}, setFillColor: () => {}, rect: () => {},
    } as never;
    renderSection(doc, autoTable, SECTION, 210, 297, 10, { r: 0, g: 0, b: 0 });
    return calls;
  };

  it('hands every band to the table, in order', () => {
    const calls = capture();
    expect(calls.length).toBeGreaterThan(0);
    const labels = calls[calls.length - 1]!.body.map(r => r[0]);
    expect(labels).toEqual(BANDS);
  });

  it('gives every row three cells', () => {
    const body = capture()[0]!.body;
    for (const r of body) expect(r.length, r.join('|')).toBe(3);
  });

  it('formats the margin without NaN', () => {
    const body = capture()[0]!.body;
    expect(body.map(r => r[2]).join('|')).not.toContain('NaN');
    expect(body.find(r => r[0] === 'Gross Profit')![2]).toMatch(/100\.0%/);
    expect(body.find(r => r[0] === 'Operating Expenses')![2]).toBe('');
  });

  it('omits a nil band on both packs alike', () => {
    const bare = { ...SECTION, data: { ...(SECTION as never as { data: Record<string, number> }).data, otherIncome: 0, otherExpenses: 0 } } as never;
    const html = renderSectionHtml(bare);
    expect(html).not.toContain('<td>Other Income</td>');
    expect(html).toContain('<td>Operating Profit</td>');

    const calls: Array<{ body: string[][] }> = [];
    const autoTable = (_d: unknown, o: { body: string[][] }) => { calls.push(o); };
    const doc = {
      lastAutoTable: { finalY: 20 }, setFontSize: () => {}, setFont: () => {},
      setTextColor: () => {}, text: () => {}, addPage: () => {}, setFillColor: () => {}, rect: () => {},
    } as never;
    renderSection(doc, autoTable, bare, 210, 297, 10, { r: 0, g: 0, b: 0 });
    const labels = calls[0]!.body.map(r => r[0]);
    expect(labels).not.toContain('Other Income');
    expect(labels).toContain('Operating Profit');
  });

  it('renders the balance sheet Equity before Liabilities with the combined total', () => {
    const calls: Array<{ body: string[][] }> = [];
    const autoTable = (_d: unknown, o: { body: string[][] }) => { calls.push(o); };
    const doc = {
      lastAutoTable: { finalY: 20 }, setFontSize: () => {}, setFont: () => {},
      setTextColor: () => {}, text: () => {}, addPage: () => {}, setFillColor: () => {}, rect: () => {},
    } as never;
    renderSection(doc, autoTable, BALANCE_SHEET, 210, 297, 10, { r: 0, g: 0, b: 0 });
    expect(calls[0]!.body.map(row => row[0])).toEqual(BALANCE_SHEET_ROWS);
  });
});

/**
 * Non-positive turnover. `reportPackService` emits `grossMargin`/`netMargin`
 * as null there — a margin needs turnover to be a margin OF — and both legacy
 * renderers used to coerce that null to 0 and print "0.0%", a figure nothing
 * else on the page supports, on documents sent to clients.
 */
describe('legacy packs on non-positive turnover', () => {
  /** The income_statement section reportPackService actually builds when
   *  credit notes exceed sales. Built through the service, not hand-written,
   *  so a service that stopped nulling would fail here too. */
  const negativeSection = () => {
    const pack = buildReportPack('board', {
      companyName: 'Loss Co', period: '2026-01', revenue: -1000, costOfSales: 0,
      operatingExpenses: 500, netProfit: -1500, totalAssets: 0, totalLiabilities: 0,
      totalEquity: 0, currentAssets: 0, currentLiabilities: 0, cash: 0,
      accountsReceivable: 0, accountsPayable: 0, inventory: 0,
    }, '2026-01-01', '2026-01-31');
    return pack.sections.find(s => s.type === 'income_statement')!;
  };

  it('the service still hands the renderers a null margin', () => {
    const d = negativeSection().data;
    expect(d.grossMargin).toBeNull();
    expect(d.netMargin).toBeNull();
  });

  it('the HTML pack prints the not-meaningful cell, never 0.0%', () => {
    const html = renderSectionHtml(negativeSection() as never);
    expect(html).not.toContain('0.0%');
    expect(html).not.toContain('%');
    const cells = html.match(/<td class="num muted">([^<]*)<\/td>/g) ?? [];
    expect(cells.filter(c => c.includes(NO_MARGIN_CELL)).length).toBe(2);
  });

  it('the PDF pack prints the not-meaningful cell, never 0.0%', () => {
    const calls: Array<{ body: string[][] }> = [];
    const autoTable = (_d: unknown, o: { body: string[][] }) => { calls.push(o); };
    const doc = {
      lastAutoTable: { finalY: 20 }, setFontSize: () => {}, setFont: () => {},
      setTextColor: () => {}, text: () => {}, addPage: () => {}, setFillColor: () => {}, rect: () => {},
    } as never;
    renderSection(doc, autoTable, negativeSection() as never, 210, 297, 10, { r: 0, g: 0, b: 0 });
    const body = calls[0]!.body;
    const margins = body.map(r => r[2]!);
    expect(margins.join('|')).not.toContain('%');
    expect(body.find(r => r[0] === 'Gross Profit')![2]).toBe(NO_MARGIN_CELL);
    expect(body.find(r => r[0] === 'Net Profit')![2]).toBe(NO_MARGIN_CELL);
    // A band that never had a margin still gets a blank cell, not the dash.
    expect(body.find(r => r[0] === 'Operating Expenses')![2]).toBe('');
  });
});
