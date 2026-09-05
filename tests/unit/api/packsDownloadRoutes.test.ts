import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const renderPagePdfMock = vi.fn(async () => Buffer.from('%PDF-1.7 fake'));
vi.mock('@/lib/pdf/renderPagePdf', () => ({ renderPagePdf: (...a: unknown[]) => renderPagePdfMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const rateLimitMock = vi.fn(async () => true);
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => rateLimitMock(...a) }));
const sqlMock = vi.fn(async () => [{ name: 'Acme Fibre (Pty) Ltd' }]);
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));

import pdfRoute from '../../../pages/api/accounting/packs/[id]/pdf';
import { log } from '@/lib/logger';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function mockRes() {
  const res = {
    statusCode: 0, headers: {} as Record<string, unknown>, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    end(p: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

function req(query: Record<string, string>, method = 'GET') {
  return { method, query, url: '/api/accounting/packs/management/pdf', companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest;
}

describe('GET /api/accounting/packs/[id]/pdf', () => {
  const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;

  beforeEach(() => {
    renderPagePdfMock.mockClear();
    rateLimitMock.mockClear();
    rateLimitMock.mockResolvedValue(true);
    sqlMock.mockClear();
    sqlMock.mockResolvedValue([{ name: 'Acme Fibre (Pty) Ltd' }]);
    vi.mocked(log.info).mockClear();
    process.env.PRINT_TOKEN_SECRET = 'a'.repeat(32);
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
    else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
  });

  it('renders the pack page for the requested pack and period', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'management', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(renderPagePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY,
      userId: USER,
      path: '/accounting/reports/report-packs',
      query: { pack: 'management', from: '2026-01-01', to: '2026-09-05' },
      apiPaths: ['/api/accounting/reports-pack', '/api/accounting/packs/management/trend'],
    }));
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.statusCode).toBe(200);
  });

  it('names the download after the pack and the period', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.headers['Content-Disposition']).toContain('report-pack-board-2026-01-01-to-2026-09-05.pdf');
  });

  it('prefixes the download with a sanitised company slug', async () => {
    sqlMock.mockResolvedValueOnce([{ name: 'Acme Fibre (Pty) Ltd!' }]);
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), res);
    const disposition = String(res.headers['Content-Disposition']);
    expect(disposition).toContain('filename="acme-fibre-pty-ltd-report-pack-board-2026-01-01-to-2026-09-05.pdf"');
  });

  it('rejects an unknown pack id before rendering anything', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'secret', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  it('rejects a non-ISO date rather than passing it into a URL', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '01/01/2026', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  it('refuses a POST', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('rate-limits repeated pack downloads', async () => {
    rateLimitMock.mockResolvedValueOnce(false);
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(429);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  it('refuses to mint with a clear 503 when PRINT_TOKEN_SECRET is unset', async () => {
    delete process.env.PRINT_TOKEN_SECRET;
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(503);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  it('audits every download with company, user, type, period and byte count', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'monthly', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Pack PDF'),
      expect.objectContaining({
        companyId: COMPANY,
        userId: USER,
        packType: 'monthly',
        from: '2026-01-01',
        to: '2026-09-05',
        bytes: expect.any(Number),
      }),
      expect.any(String),
    );
  });
});
