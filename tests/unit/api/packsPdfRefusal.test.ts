/**
 * WHAT THE PDF ROUTE ANSWERS WHEN A BOARD PACK CANNOT BE PRODUCED.
 *
 * A 422 says "this company's own pack refuses to be printed" — the layout
 * gate, written for a reader, thrown as a `PackRefusal`. The route used to
 * answer 422 for ANYTHING the diagnostic compose threw: a driver error, a
 * `TypeError` from a composition module. A defect in this codebase was
 * reported to the user as a rule their books had broken, answered 4xx so no
 * alert fired, and the render error that started it was dropped unlogged.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const renderPagePdfMock = vi.fn();
const buildBoardPackDocumentMock = vi.fn();
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/pdf/renderPagePdf', () => ({ renderPagePdf: (...a: unknown[]) => renderPagePdfMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: logMock }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
// Passed through, so what the handler THROWS is what the test sees: a thrown
// error is the route asking for a 500.
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/packs/pages/packFurniture', () => ({
  buildPackFurniture: vi.fn(async () => ({
    companyName: 'Acme Fibre (Pty) Ltd', packLabel: 'Board pack', period: '1 January 2026 to 5 September 2026',
    draft: true, generatedAt: '2026-09-07T06:00:00.000Z',
  })),
}));
vi.mock('@/lib/pdf/printFurniture', () => ({
  buildFooterHtml: () => '<footer/>',
  buildPdfMetadata: () => ({ title: 't', subject: 's' }),
}));
vi.mock('@/modules/accounting/services/packs/pages/boardPackDocument', () => ({
  buildBoardPackDocument: (...a: unknown[]) => buildBoardPackDocumentMock(...a),
}));

import pdfRoute from '../../../pages/api/accounting/packs/[id]/pdf';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';

const COMPANY = '11111111-1111-4111-8111-111111111111';

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

function req(id = 'board') {
  return {
    method: 'GET', query: { id, from: '2026-01-01', to: '2026-09-05' },
    url: `/api/accounting/packs/${id}/pdf`,
    headers: { cookie: 'sb-access-token=session' },
    companyId: COMPANY, user: { id: 'u1', email: 'cfo@acme.test' },
  } as unknown as NextApiRequest;
}

const RENDER_TIMEOUT = new Error('renderPagePdf: timed out after 30000ms waiting for [data-print-ready]');
const LAYOUT_REFUSAL = new PackRefusal(
  'fitPageToBox: page 5 needs 264.9mm of a 255.0mm box',
  'This pack could not be laid out on twelve sheets.',
);

const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.PRINT_TOKEN_SECRET = 'a'.repeat(32);
  renderPagePdfMock.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
  buildBoardPackDocumentMock.mockResolvedValue({ pages: [] });
});
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
  else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
});

describe('GET /api/accounting/packs/board/pdf when the pack cannot be produced', () => {
  it('answers 422 with the reader\'s sentence when the pack refuses itself', async () => {
    renderPagePdfMock.mockRejectedValue(RENDER_TIMEOUT);
    buildBoardPackDocumentMock.mockRejectedValue(LAYOUT_REFUSAL);
    const res = mockRes();

    await pdfRoute(req(), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BUSINESS_RULE_VIOLATION', message: 'This pack could not be laid out on twelve sheets.' },
    });
    // The millimetres are for the log, not for the reader.
    expect(JSON.stringify(res.body)).not.toContain('fitPageToBox');
    expect(JSON.stringify(logMock.warn.mock.calls)).toContain('fitPageToBox: page 5 needs 264.9mm');
  });

  it.each([
    ['a code bug', new TypeError("Cannot read properties of undefined (reading 'blocks')")],
    ['a database error', Object.assign(new Error('relation "afs_documents" does not exist'), { code: '42P01' })],
    ['a bare assertion', new Error('anchorRow: no row matched')],
  ])('does not answer 422 for %s in the compose', async (_what, failure) => {
    renderPagePdfMock.mockRejectedValue(RENDER_TIMEOUT);
    buildBoardPackDocumentMock.mockRejectedValue(failure);
    const res = mockRes();

    // Thrown past the handler: withErrorHandler turns that into a 500.
    await expect(pdfRoute(req(), res)).rejects.toBe(failure);

    expect(res.statusCode).not.toBe(422);
    expect(res.body).toBeUndefined();
  });

  it('logs the render error it started from, which used to be dropped', async () => {
    renderPagePdfMock.mockRejectedValue(RENDER_TIMEOUT);
    buildBoardPackDocumentMock.mockRejectedValue(new TypeError('x is not a function'));

    await expect(pdfRoute(req(), mockRes())).rejects.toBeInstanceOf(TypeError);

    expect(JSON.stringify(logMock.error.mock.calls)).toContain('timed out after 30000ms');
  });

  it('surfaces the renderer\'s own failure when the pack itself composes', async () => {
    renderPagePdfMock.mockRejectedValue(RENDER_TIMEOUT);
    const res = mockRes();
    await expect(pdfRoute(req(), res)).rejects.toBe(RENDER_TIMEOUT);
    expect(res.statusCode).not.toBe(422);
  });

  it('streams the PDF when nothing refuses', async () => {
    const res = mockRes();
    await pdfRoute(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/pdf');
  });
});
