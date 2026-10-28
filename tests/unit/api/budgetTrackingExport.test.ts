/**
 * pages/api/accounting/budget-tracking-export (budgets P3 §2.8): the CSV and
 * the XLSX print exactly the figures the JSON route returns for the same
 * request (every cell of every line and band), because both serialise the
 * same engine result through the same row adapter; an absent figure is an
 * empty cell, never 0; text goes through csvVal (formula injection); section
 * rows are skipped as the grid skips them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import ExcelJS from 'exceljs';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
const buildBudgetTrackingReport = vi.fn();
vi.mock('@/modules/accounting/services/budgets/tracking/budgetTrackingService', () => ({
  buildBudgetTrackingReport: (...a: unknown[]) => buildBudgetTrackingReport(...a),
}));
vi.mock('@/modules/accounting/services/reports/companyName', () => ({ getCompanyName: vi.fn(async () => 'Acme (Pty) Ltd') }));

import jsonHandler from '../../../pages/api/accounting/reports-budget-tracking';
import exportHandler from '../../../pages/api/accounting/budget-tracking-export';
import { buildTrackingLines, type AccountMeta } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import type { BudgetTrackingReport, TrackingFigures } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const MONTHS = ['2026-06', '2026-07'];
const meta = (accountId: string, accountCode: string, accountName: string, accountType: 'revenue' | 'expense', accountSubtype: string | null = null): AccountMeta =>
  ({ accountId, accountCode, accountName, accountType, accountSubtype });

function fixture(): BudgetTrackingReport {
  const accounts = new Map<string, AccountMeta>([
    ['s', meta('s', '4000', 'Sales', 'revenue')],
    ['i', meta('i', '4900', 'Interest', 'revenue', 'other_income')],
    ['c', meta('c', '5000', 'Cost of sales', 'expense', 'cost_of_sales')],
    ['r', meta('r', '6000', '=cmd|calc', 'expense')],
    ['w', meta('w', '6100', 'Wages, "staff"', 'expense')],
  ]);
  const plan = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-07-31', '2026-10-26');
  const a = (accountId: string, month: string, amount: number) => ({ accountId, month, amount });
  const b = (accountId: string, month: string, amount: number, cls: 'included' | 'coarser' = 'included') => ({ accountId, month, amount, cls });
  const lines = buildTrackingLines({
    accounts, windowMonths: MONTHS, plan,
    actuals: [a('s', '2026-06', 1000.1), a('s', '2026-07', 1234.56), a('i', '2026-06', 12.3), a('c', '2026-07', 400.4), a('r', '2026-06', 300), a('w', '2026-07', 80.08)],
    budgets: [b('s', '2026-06', 900), b('s', '2026-07', 1100), b('c', '2026-06', 500), b('c', '2026-07', 0), b('w', '2026-07', 0), b('r', '2026-06', 250, 'coarser')],
  });
  return {
    window: { period: 'custom', label: '2026-06 to 2026-07', startDate: '2026-06-01', endDate: '2026-07-31', months: MONTHS, fiscalYear: 2027, inProgress: null, postedThrough: '2026-07-31', notStarted: false },
    version: { id: 'v1', name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false },
    filter: {},
    projection: { fiscalYear: 2027, cutoff: plan.cutoff, actualMonths: plan.actualMonths, budgetMonths: plan.budgetMonths },
    lines,
    bands: buildBands(lines),
    notices: { unbudgetedCount: 2, unbudgetedActual: { income: 12.3, expense: 300 }, unallocatedBudget: { income: 0, expense: 250 }, noVersion: false, noVersionYears: [] },
    years: [],
  };
}

function mockRes() {
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}
async function call(h: typeof jsonHandler, query: Record<string, unknown>) {
  const res = mockRes();
  await h({ method: 'GET', query, companyId: COMPANY } as unknown as NextApiRequest, res);
  return res;
}

/** RFC 4180 rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

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
      'Dimension filter': 'None (company total)', 'Projection cutoff': 'Actuals to 2026-07-31, budget after',
    });
  });

  it('L4: a window reaching a year with no version says so in the header, CSV and XLSX', async () => {
    buildBudgetTrackingReport.mockImplementation(async () => {
      const r = fixture();
      return { ...r, notices: { ...r.notices, noVersion: false, noVersionYears: [2026] } };
    });
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(csv.find((r) => r[0] === 'Notice')).toEqual(['Notice', 'No budget for FY2026 in this window']);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await call(exportHandler, { ...query, format: 'xlsx' })).sent as ArrayBuffer);
    const head: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => { head.push([r.getCell(1).value, r.getCell(2).value]); });
    expect(head).toContainEqual(['Notice', 'No budget for FY2026 in this window']);
    // A fully versioned window carries no notice line.
    buildBudgetTrackingReport.mockImplementation(async () => fixture());
    const plain = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(plain.find((r) => r[0] === 'Notice')).toBeUndefined();
  });

  it('R2: a cross-FY window names every version it reads, per year, in CSV and XLSX', async () => {
    buildBudgetTrackingReport.mockImplementation(async () => ({
      ...fixture(),
      version: { id: 'v28', name: 'Board v2', kind: 'reforecast', status: 'approved', isPrimary: true },
      versionsByFy: { 2027: { id: 'v27', name: 'Original', kind: 'original', status: 'approved' }, 2028: { id: 'v28', name: 'Board v2', kind: 'reforecast', status: 'approved' } },
    }));
    const want = 'FY2027: Original · approved; FY2028: Board v2 · approved';
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(csv.find((r) => r[0] === 'Version')).toEqual(['Version', want]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await call(exportHandler, { ...query, format: 'xlsx' })).sent as ArrayBuffer);
    const head: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => { head.push([r.getCell(1).value, r.getCell(2).value]); });
    expect(head).toContainEqual(['Version', want]);
  });

  it('R2: a year of a cross-FY window with no version is named as such', async () => {
    buildBudgetTrackingReport.mockImplementation(async () => {
      const r = fixture();
      return { ...r, versionsByFy: { 2027: { id: 'v27', name: 'Original', kind: 'original', status: 'approved' } }, notices: { ...r.notices, noVersionYears: [2026] } };
    });
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(csv.find((r) => r[0] === 'Version')).toEqual(['Version', 'FY2026: no budget in this window; FY2027: Original · approved']);
  });

  it('r4: a year whose version holds no budget in this window is never presented as a budget', async () => {
    buildBudgetTrackingReport.mockImplementation(async () => {
      const r = fixture();
      return {
        ...r,
        versionsByFy: { 2026: { id: 'v26', name: 'Original', kind: 'original', status: 'draft', empty: true }, 2027: { id: 'v27', name: 'Original', kind: 'original', status: 'approved' } },
        notices: { ...r.notices, noVersionYears: [2026] },
      };
    });
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(csv.find((r) => r[0] === 'Version')).toEqual(['Version', 'FY2026: no budget in this window; FY2027: Original · approved']);
    expect(csv.find((r) => r[0] === 'Notice')).toEqual(['Notice', 'No budget for FY2026 in this window']);
  });

  it('G2: a single-year window whose version holds no budget in it says so beside the version', async () => {
    buildBudgetTrackingReport.mockImplementation(async () => {
      const r = fixture();
      return { ...r, version: { id: 'v1', name: 'Original', kind: 'original', status: 'approved', isPrimary: true, empty: true }, notices: { ...r.notices, noVersion: true, noVersionYears: [2027] } };
    });
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(csv.find((r) => r[0] === 'Version')).toEqual(['Version', 'Original · approved (no budget in this window)']);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await call(exportHandler, { ...query, format: 'xlsx' })).sent as ArrayBuffer);
    const head: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => { head.push([r.getCell(1).value, r.getCell(2).value]); });
    expect(head).toContainEqual(['Version', 'Original · approved (no budget in this window)']);
  });

  it('refuses an unknown format and a malformed query before any work', async () => {
    expect((await call(exportHandler, { ...query, format: 'pdf' })).statusCode).toBe(400);
    expect((await call(exportHandler, { period: 'quarter', quarter: '7', format: 'csv' })).statusCode).toBe(400);
    expect(buildBudgetTrackingReport).not.toHaveBeenCalled();
  });
});
