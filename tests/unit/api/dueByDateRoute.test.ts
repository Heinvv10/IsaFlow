/** /api/accounting/reports/due-by-date and its Excel export: parameter handling and status codes. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/reports/dueByDateService', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/reports/dueByDateService')>(
    '@/modules/accounting/services/reports/dueByDateService',
  );
  return { ...actual, appToday: () => '2026-11-05', getDueByDateReport: vi.fn() };
});

import { DueByDateInputError, getDueByDateReport } from '@/modules/accounting/services/reports/dueByDateService';
import { buildDueByDateSide, netPosition } from '@/modules/accounting/utils/dueByDate';
import handler from '../../../pages/api/accounting/reports/due-by-date';
import xlsxHandler from '../../../pages/api/accounting/reports/due-by-date-xlsx';

type Handler = (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>;

function call(h: unknown, query: Record<string, unknown>, method = 'GET') {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string>, chunks: [] as Buffer[] };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; return this; },
    setHeader(k: string, v: string) { out.headers[k] = v; return this; },
    end() { return this; },
    write(c: Uint8Array | string) { out.chunks.push(Buffer.from(c)); return true; },
    on() { return this; }, once() { return this; }, emit() { return true; },
  };
  const req = { method, companyId: 'co-1', query, headers: {} };
  return (h as Handler)(req as unknown as NextApiRequest, res as unknown as NextApiResponse).then(() => out);
}

const report = () => {
  const ap = buildDueByDateSide('ap', [], '2026-11-05', '2026-11-30');
  const ar = buildDueByDateSide('ar', [], '2026-11-05', '2026-11-30');
  return { today: '2026-11-05', byDate: '2026-11-30', ap, ar, netPosition: netPosition(ar.totals, ap.totals) };
};

beforeEach(() => { vi.mocked(getDueByDateReport).mockReset().mockResolvedValue(report()); });

describe('GET due-by-date', () => {
  it('passes by_date through and wraps the report in the success envelope', async () => {
    const r = await call(handler, { by_date: '2026-12-15' });
    expect(r.status).toBe(200);
    expect(getDueByDateReport).toHaveBeenCalledWith('co-1', '2026-12-15');
    expect((r.body as { data: { netPosition: number } }).data.netPosition).toBe(0);
  });

  it('defaults by_date to the end of the current (SAST) month', async () => {
    await call(handler, {});
    expect(getDueByDateReport).toHaveBeenCalledWith('co-1', '2026-11-30');
  });

  it('answers 400 with the reason when the service refuses the date', async () => {
    vi.mocked(getDueByDateReport).mockRejectedValue(new DueByDateInputError('by_date must be today or later (today is 2026-11-05)'));
    const r = await call(handler, { by_date: '2026-11-01' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('today or later');
  });

  it('answers 400 for a repeated by_date and 405 for a non-GET', async () => {
    expect((await call(handler, { by_date: ['2026-11-30', '2026-12-31'] })).status).toBe(400);
    expect((await call(handler, {}, 'POST')).status).toBe(405);
    expect(getDueByDateReport).not.toHaveBeenCalled();
  });
});

describe('GET due-by-date-xlsx', () => {
  it('sends an xlsx attachment named for the date', async () => {
    const r = await call(xlsxHandler, { by_date: '2026-11-30' });
    expect(r.headers['Content-Type']).toContain('spreadsheetml');
    expect(r.headers['Content-Disposition']).toContain('due-by-date-2026-11-30.xlsx');
    const file = Buffer.concat(r.chunks);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Due by date', 'AR invoices', 'AP invoices']);
  });

  it('refuses a past date with 400 and no file', async () => {
    vi.mocked(getDueByDateReport).mockRejectedValue(new DueByDateInputError('by_date must be today or later'));
    const r = await call(xlsxHandler, { by_date: '2026-11-01' });
    expect(r.status).toBe(400);
    expect(r.headers['Content-Type']).toBeUndefined();
  });
});
