/**
 * The rendered surfaces — XLSX and the AFS statement tab.
 *
 * Four of the five surfaces that display these bands had NO test: deleting the
 * XLSX Operating Profit row, suppressing its Other Income section, or breaking
 * the AFS Operating Profit block each left the full 8,000-test suite green.
 * The AFS one matters most — it is a statutory statement, its own module doc
 * names it "the one to check first when this shape changes", and the reason it
 * was missed the first time is that nothing failed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ExcelJS from 'exceljs';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { buildIncomeStatementWorkbook } from '@/../pages/api/accounting/income-statement-xlsx';
import { IncomeStatementBlock } from '@/components/accounting/afs/AfsStatementsTab';

const glRow = (
  code: string, name: string, type: 'revenue' | 'expense',
  subtype: string | null, debit: number, credit: number,
) => ({
  account_code: code, account_name: name, account_type: type,
  account_subtype: subtype, total_debit: debit, total_credit: credit,
});

const LAYERED = [
  glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000000),
  glRow('4300', 'Interest Received', 'revenue', 'other_income', 0, 53787.07),
  glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 1800000, 0),
  glRow('6000', 'Rent', 'expense', 'operating_expenses', 400000, 0),
  glRow('5810', 'Interest Expense', 'expense', 'finance_cost', 120000, 0),
];

beforeEach(() => sqlMock.mockReset());

const report = async () => {
  sqlMock.mockResolvedValue(LAYERED);
  return getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
};

describe('XLSX workbook — every band is written', () => {
  const cells = async (): Promise<string[]> => {
    const wb = await buildIncomeStatementWorkbook(await report(), 'Test Co');
    const ws = wb.worksheets[0]!;
    const out: string[] = [];
    ws.eachRow(r => out.push(r.values ? JSON.stringify(r.values) : ''));
    return out;
  };

  it('writes Operating Profit, Other Income and Other Expenses', async () => {
    const text = (await cells()).join('\n');
    expect(text).toContain('Operating Profit');
    expect(text).toContain('Total Other Income');
    expect(text).toContain('Total Other Expenses');
    expect(text).toContain('Interest Received');
    expect(text).toContain('Interest Expense');
  });

  it('places Other Income above the Operating Profit that contains it', async () => {
    const rows = await cells();
    const at = (needle: string) => rows.findIndex(r => r.includes(needle));
    expect(at('Total Other Income')).toBeLessThan(at('Total Operating Expenses'));
    expect(at('Operating Profit')).toBeGreaterThan(at('Total Other Income'));
    expect(at('Total Other Expenses')).toBeGreaterThan(at('Operating Profit'));
  });

  it('omits the sections when there is nothing in them', async () => {
    sqlMock.mockResolvedValue([
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000),
      glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 1000, 0),
    ]);
    const r = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    const wb = await buildIncomeStatementWorkbook(r, 'Test Co');
    const out: string[] = [];
    wb.worksheets[0]!.eachRow(row => out.push(row.values ? JSON.stringify(row.values) : ''));
    const text = out.join('\n');
    expect(text).not.toContain('Total Other Income');
    expect(text).not.toContain('Total Other Expenses');
    expect(text).toContain('Operating Profit');
  });
});

describe('AFS statement tab — the statutory statement FOOTS', () => {
  it('renders every band, so gross profit reconciles to net profit', async () => {
    const r = await report();
    const html = renderToStaticMarkup(
      IncomeStatementBlock({ report: r, periodStart: '2026-01-01', periodEnd: '2026-12-31' }) as never,
    );
    for (const label of ['Turnover', 'Cost of Sales', 'Gross Profit', 'Other Income',
                         'Operating Expenses', 'Operating Profit', 'Other Expenses', 'Net Profit']) {
      expect(html, label).toContain(label);
    }
  });

  it('shows a reader every figure needed to get from gross profit to net profit', async () => {
    const r = await report();
    const html = renderToStaticMarkup(
      IncomeStatementBlock({ report: r, periodStart: '2026-01-01', periodEnd: '2026-12-31' }) as never,
    );
    // Without Other Income and Other Expenses on the page the statement is
    // short by their net — R341,712.00 on Brightsphere in production.
    expect(r.grossProfit + r.totalOtherIncome - r.totalOperatingExpenses)
      .toBeCloseTo(r.operatingProfit, 2);
    expect(r.operatingProfit - r.totalOtherExpenses).toBeCloseTo(r.netProfit, 2);
    const digits = (n: number) => n.toFixed(2).replace('.', '');
    expect(html.replace(/[^0-9]/g, '')).toContain(digits(r.totalOtherIncome));
    expect(html.replace(/[^0-9]/g, '')).toContain(digits(r.totalOtherExpenses));
    expect(html.replace(/[^0-9]/g, '')).toContain(digits(r.operatingProfit));
  });
});
