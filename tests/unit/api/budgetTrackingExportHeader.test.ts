/**
 * pages/api/accounting/budget-tracking-export, the header block (moved unchanged out of
 * budgetTrackingExport.test.ts for the 300-line rule): the notice lines a reader needs beside blank
 * Budget columns (no budget for a year in this window, lines budgeted for part of it), each year's
 * version on a cross-FY window, and an empty version marked as such; CSV and XLSX alike.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import exportHandler from '../../../pages/api/accounting/budget-tracking-export';
import { call, fixture, parseCsv } from './helpers/budgetTrackingExportFixture';

beforeEach(() => {
  vi.clearAllMocks();
  buildBudgetTrackingReport.mockImplementation(async () => fixture());
});

describe('budget-tracking-export header', () => {
  const query = { period: 'custom', from: '2026-06', to: '2026-07' };

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

  it('F3: partial lines are explained in the header, CSV and XLSX', async () => {
    buildBudgetTrackingReport.mockImplementation(async () => {
      const r = fixture();
      return { ...r, notices: { ...r.notices, partialBudget: { count: 2, actual: { income: 100, expense: 40 } } } };
    });
    const want = '2 lines have a budget for only part of this window; their Budget is blank';
    const csv = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(csv.filter((r) => r[0] === 'Notice').map((r) => r[1])).toContain(want);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await call(exportHandler, { ...query, format: 'xlsx' })).sent as ArrayBuffer);
    const head: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => { head.push([r.getCell(1).value, r.getCell(2).value]); });
    expect(head).toContainEqual(['Notice', want]);
    // None: no line.
    buildBudgetTrackingReport.mockImplementation(async () => ({ ...fixture(), notices: { ...fixture().notices, partialBudget: null } }));
    const plain = parseCsv(String((await call(exportHandler, { ...query, format: 'csv' })).sent));
    expect(plain.filter((r) => r[0] === 'Notice')).toEqual([]);
  });
});
