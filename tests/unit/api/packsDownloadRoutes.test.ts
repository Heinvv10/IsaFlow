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

// The deck itself is built for real (buildPackDeck is pure); only the two
// database reads and the byte renderer are stood in for.
vi.mock('@/modules/accounting/services/reports/reportPackDataService', () => ({
  getReportPackInput: vi.fn(async () => ({
    companyName: 'Acme Fibre (Pty) Ltd', period: '2026-01-01 to 2026-09-05',
    revenue: 1000, costOfSales: 400, operatingExpenses: 200, netProfit: 400,
    totalAssets: 5000, totalLiabilities: 2000, totalEquity: 3000,
    currentAssets: 2500, currentLiabilities: 1000, cash: 800,
    accountsReceivable: 900, accountsPayable: 500, inventory: 100,
    otherIncome: 0, otherExpenses: 0, operatingProfit: 400,
    inventoryCaveat: null, classificationCaveat: null,
  })),
}));
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({ getPackTrend: vi.fn(async () => []) }));
const renderPackPptxMock = vi.fn(async () => Buffer.from('PK-pptx-bytes'));
vi.mock('@/modules/accounting/services/packs/pptxExportService', () => ({
  renderPackPptx: (...a: unknown[]) => renderPackPptxMock(...a),
}));

import pdfRoute from '../../../pages/api/accounting/packs/[id]/pdf';
import pptxRoute from '../../../pages/api/accounting/packs/[id]/pptx';
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

/** The session cookie is what `withRenderSlot`'s precheck looks for before it
 *  spends a render slot — see src/lib/pdf/withRenderSlot.ts. Its VALUE is never
 *  read here; withAuth (mocked out above) is what would verify it. */
function req(query: Record<string, string>, method = 'GET') {
  return {
    method, query, url: '/api/accounting/packs/management/pdf',
    headers: { cookie: 'sb-access-token=session' },
    companyId: COMPANY, user: { id: USER },
  } as unknown as NextApiRequest;
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

  /**
   * ADVERSARIAL MEDIUM-1 / HIGH-1. Each render holds this request's withAuth
   * pool connection for its whole duration and the headless browser re-enters
   * the API for the report, so unbounded concurrency exhausts the pool for
   * every tenant. Over the wait bound the route answers a retryable 503 rather
   * than queueing indefinitely or 500ing.
   *
   * The slot is taken by an OUTER wrapper around withAuth (see the route's
   * default export and tests/unit/lib/pdf/withRenderSlot.test.ts), so a queued
   * request holds no connection while it waits. These cases assert what the
   * route does with the two outcomes; the ordering itself is pinned there.
   */
  describe('concurrent render bound', () => {
    const ORIGINAL = {
      max: process.env.PDF_MAX_CONCURRENT_RENDERS,
      wait: process.env.PDF_RENDER_QUEUE_TIMEOUT_MS,
    };
    afterEach(() => {
      if (ORIGINAL.max === undefined) delete process.env.PDF_MAX_CONCURRENT_RENDERS;
      else process.env.PDF_MAX_CONCURRENT_RENDERS = ORIGINAL.max;
      if (ORIGINAL.wait === undefined) delete process.env.PDF_RENDER_QUEUE_TIMEOUT_MS;
      else process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = ORIGINAL.wait;
    });

    const download = () => pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), mockRes());

    it('makes the request past the bound wait, then answers 503 rather than rendering', async () => {
      process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
      process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '25';

      let finishFirst!: () => void;
      renderPagePdfMock.mockImplementationOnce(async () => {
        await new Promise<void>((r) => { finishFirst = r; });
        return Buffer.from('%PDF-1.7 fake');
      });

      const first = download();
      await new Promise((r) => setTimeout(r, 0));
      expect(renderPagePdfMock).toHaveBeenCalledTimes(1);

      const refusedRes = mockRes();
      await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), refusedRes);
      expect(refusedRes.statusCode).toBe(503);
      // Refused, not queued forever, and no second render was ever started.
      expect(renderPagePdfMock).toHaveBeenCalledTimes(1);

      finishFirst();
      await first;
    });

    it('lets a queued request through once a slot frees, rather than failing it', async () => {
      process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
      process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '5000';

      let finishFirst!: () => void;
      renderPagePdfMock.mockImplementationOnce(async () => {
        await new Promise<void>((r) => { finishFirst = r; });
        return Buffer.from('%PDF-1.7 fake');
      });

      const first = download();
      await new Promise((r) => setTimeout(r, 0));
      const queuedRes = mockRes();
      const queued = pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), queuedRes);
      await new Promise((r) => setTimeout(r, 0));
      expect(renderPagePdfMock).toHaveBeenCalledTimes(1);

      finishFirst();
      await Promise.all([first, queued]);
      expect(renderPagePdfMock).toHaveBeenCalledTimes(2);
      expect(queuedRes.statusCode).toBe(200);
    });
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

describe('GET /api/accounting/packs/[id]/pptx', () => {
  beforeEach(() => {
    renderPackPptxMock.mockClear();
    rateLimitMock.mockClear();
    rateLimitMock.mockResolvedValue(true);
    sqlMock.mockClear();
    sqlMock.mockResolvedValue([{ name: 'Acme Fibre (Pty) Ltd' }]);
    vi.mocked(log.info).mockClear();
  });

  it('streams a pptx named after the company, the pack and the period', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'management', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['Content-Type'])).toContain('presentationml.presentation');
    expect(String(res.headers['Content-Disposition']))
      .toContain('acme-fibre-pty-ltd-report-pack-management-2026-01-01-to-2026-09-05.pptx');
  });

  it('renders the deck the pack service produced, title slide first', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'management', from: '2026-01-01', to: '2026-09-05' }), res);
    const [slides] = renderPackPptxMock.mock.calls[0] as unknown as [Array<{ kind: string; subtitle?: string }>];
    expect(slides[0]).toEqual(expect.objectContaining({ kind: 'title', subtitle: 'Management Pack' }));
    expect(slides.length).toBeGreaterThan(1);
  });

  it('rejects an unknown pack id before touching the database', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'secret', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPackPptxMock).not.toHaveBeenCalled();
  });

  it('rejects a non-ISO date', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'board', from: '01/01/2026', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPackPptxMock).not.toHaveBeenCalled();
  });

  it('refuses a POST', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('rate-limits repeated deck downloads', async () => {
    rateLimitMock.mockResolvedValueOnce(false);
    const res = mockRes();
    await pptxRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(429);
    expect(renderPackPptxMock).not.toHaveBeenCalled();
  });

  it('audits every download with company, user, type, period and byte count', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'monthly', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Pack PPTX'),
      expect.objectContaining({
        companyId: COMPANY, userId: USER, packType: 'monthly',
        from: '2026-01-01', to: '2026-09-05', bytes: expect.any(Number),
      }),
      expect.any(String),
    );
  });
});
