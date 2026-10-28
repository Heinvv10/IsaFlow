/**
 * pages/api/accounting/budget-tracking-export (budgets P3 §2.8): the CSV and
 * the XLSX print exactly the figures the JSON route returns for the same
 * request (every cell of every line and band), because both serialise the
 * same engine result through the same row adapter; an absent figure is an
 * empty cell, never 0; text goes through csvVal (formula injection); section
 * rows are skipped as the grid skips them. The header and notice lines are
 * budgetTrackingExportHeader.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const checkReportRateLimit = vi.fn(async () => true);
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => checkReportRateLimit(...(a as [])) }));
const buildBudgetTrackingReport = vi.fn();
vi.mock('@/modules/accounting/services/budgets/tracking/budgetTrackingService', () => ({
  buildBudgetTrackingReport: (...a: unknown[]) => buildBudgetTrackingReport(...a),
}));
vi.mock('@/modules/accounting/services/reports/companyName', () => ({ getCompanyName: vi.fn(async () => 'Acme (Pty) Ltd') }));

import jsonHandler from '../../../pages/api/accounting/reports-budget-tracking';
import exportHandler from '../../../pages/api/accounting/budget-tracking-export';
import type { BudgetTrackingReport, TrackingFigures } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { call, fixture, parseCsv } from './helpers/budgetTrackingExportFixture';

const COLUMNS = ['Code', 'Account', 'Band', 'Actual', 'Budget', 'Var R', 'Var %', 'Favourable', 'Projected FY', 'FY budget', 'Proj. var R', 'Unallocated budget'];
type Cell = string | number | null;
/** What each figure column must hold for a line or band, from the JSON. */
const expected = (f: TrackingFigures): Cell[] => [
  f.actual, f.budget, f.variance, f.variancePct === null ? null : Math.round(f.variancePct * 100) / 100,
  f.favourable === null ? null : f.favourable ? 'Y' : 'N', f.projected, f.fyBudget, f.projVariance, f.unallocatedBudget,
];

beforeEach(() => {
  vi.clearAllMocks();
  buildBudgetTrackingReport.mockImplementation(async () => fixture());
});

describe('budget-tracking-export', () => {
  const query = { period: 'custom', from: '2026-06', to: '2026-07' };

  it('CSV and XLSX carry every JSON figure, cell for cell', async () => {
    const json = (await call(jsonHandler, query)).sent as { data: BudgetTrackingReport };
    const report = json.data;
    const csvRes = await call(exportHandler, { ...query, format: 'csv' });
    expect(csvRes.headers['Content-Type']).toMatch(/text\/csv/);
    expect(csvRes.headers['Content-Disposition']).toBe('attachment; filename="budget-vs-actual-2026-06-01-2026-07-31.csv"');
    const csv = parseCsv(String(csvRes.sent));
    const head = csv.findIndex((r) => r[0] === 'Code');
    expect(csv[head]).toEqual(COLUMNS);
    const csvBody = csv.slice(head + 1).filter((r) => r.length === COLUMNS.length);

    const xlsxRes = await call(exportHandler, { ...query, format: 'xlsx' });
    expect(xlsxRes.headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsxRes.headers['Content-Disposition']).toBe('attachment; filename="budget-vs-actual-2026-06-01-2026-07-31.xlsx"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxRes.sent as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const xrows: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      xrows.push(COLUMNS.map((_, i) => { const v = r.getCell(i + 1).value; return v === null || v === undefined ? null : (v as Cell); }));
    });
    const xhead = xrows.findIndex((r) => r[0] === 'Code');
    expect(xrows[xhead]).toEqual(COLUMNS);
    const xBody = xrows.slice(xhead + 1);

    const csvCells = (r: string[]): Cell[] => r.slice(3).map((c, i) => (c === '' ? null : i === 4 ? c : Number(c)));
    const byAccount = <T extends Cell[] | string[]>(rows: T[], label: string) => rows.filter((r) => r[1] === label);
    let checked = 0;
    for (const l of report.lines) {
      const name = l.accountName.startsWith('=') ? `'${l.accountName}` : l.accountName;
      const [c] = byAccount(csvBody, name);
      expect(c, `CSV row for ${l.accountCode}`).toBeDefined();
      expect([c![0], ...csvCells(c!)]).toEqual([l.accountCode, ...expected(l)]);
      const [x] = xBody.filter((r) => r[0] === l.accountCode);
      expect(x!.slice(3).map((v, i) => (i === 3 && typeof v === 'number' ? Math.round(v * 100) / 100 : v))).toEqual(expected(l));
      checked++;
    }
    for (const b of report.bands) {
      const label = b.kind === 'band' ? `Total ${b.label}` : b.label;
      const rows = byAccount(csvBody, label);
      const hasLines = report.lines.some((l) => l.band === b.key);
      if (b.kind === 'band' && !hasLines && b.key !== 'turnover' && b.key !== 'operating_expense') { expect(rows).toEqual([]); continue; }
      expect(rows.length, label).toBe(1);
      expect(csvCells(rows[0]!), label).toEqual(expected(b));
      const x = xBody.filter((r) => r[1] === label);
      expect(x[0]!.slice(3).map((v, i) => (i === 3 && typeof v === 'number' ? Math.round(v * 100) / 100 : v)), label).toEqual(expected(b));
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
    expect(xBody.length).toBe(csvBody.length);
  });

  it('absent is an empty cell, a budgeted zero is 0.00, and section rows are skipped', async () => {
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    const interest = csv.find((r) => r[0] === '4900')!;
    expect([interest[4], interest[5], interest[6], interest[7]]).toEqual(['', '', '', '']);
    const wages = csv.find((r) => r[0] === '6100')!;
    expect([wages[4], wages[5], wages[6]]).toEqual(['0.00', '80.08', '']);
    expect(csv.filter((r) => r[1] === 'Turnover')).toEqual([]);
  });

  it('text goes through csvVal: a formula-shaped name is defused, a quote is escaped', async () => {
    const text = String((await call(exportHandler, { ...query, format: 'csv' })).sent);
    expect(text).toContain('"\'=cmd|calc"');
    expect(text).toContain('"Wages, ""staff"""');
  });

  it('XLSX text is guarded like csvVal, and ExcelJS stores it as a string, never a formula (review S1)', async () => {
    const res = await call(exportHandler, { ...query, format: 'xlsx' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.sent as ArrayBuffer);
    let found = 0;
    wb.worksheets[0]!.eachRow((r) => {
      if (r.getCell(1).value === '6000') {
        const cell = r.getCell(2);
        expect(cell.value).toBe("'=cmd|calc");
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.formula).toBeUndefined();
        found++;
      }
    });
    expect(found).toBe(1);
    // And unguarded, ExcelJS still writes a leading '=' string as a string: the guard is for the reader's spreadsheet app.
    const raw = new ExcelJS.Workbook();
    raw.addWorksheet('x').addRow(['=cmd|calc']);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await raw.xlsx.writeBuffer());
    const c = back.worksheets[0]!.getCell('A1');
    expect([c.type, c.value, c.formula]).toEqual([ExcelJS.ValueType.String, '=cmd|calc', undefined]);
  });

  it('leads with the company, window, version, filter and projection cutoff', async () => {
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    const lead = Object.fromEntries(csv.slice(0, csv.findIndex((r) => r[0] === 'Code')).filter((r) => r.length >= 2).map((r) => [r[0], r[1]]));
    expect(lead).toMatchObject({
      Company: 'Acme (Pty) Ltd', Window: '2026-06 to 2026-07 (2026-06-01 to 2026-07-31)', Version: 'Reforecast 1 · draft',
      'Dimension filter': 'None (company total)', 'Projection cutoff': 'Actuals to 2026-07-31, budget after; a line with no budget: actuals to 2026-10-31',
    });
  });

  it('honours the per-company report rate limit before any work (r7)', async () => {
    checkReportRateLimit.mockResolvedValueOnce(false);
    const res = await call(exportHandler, { ...query, format: 'csv' });
    expect(res.statusCode).toBe(429);
    expect(checkReportRateLimit).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'budget-tracking-export');
    expect(buildBudgetTrackingReport).not.toHaveBeenCalled();
  });

  it('refuses an unknown format and a malformed query before any work', async () => {
    expect((await call(exportHandler, { ...query, format: 'pdf' })).statusCode).toBe(400);
    expect((await call(exportHandler, { period: 'quarter', quarter: '7', format: 'csv' })).statusCode).toBe(400);
    expect(buildBudgetTrackingReport).not.toHaveBeenCalled();
  });
});
