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
const getPackTrendMock = vi.fn(async () => []);
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({
  getPackTrend: (...a: unknown[]) => getPackTrendMock(...a),
}));
// FINAL vs DRAFT in the running footer is read from `readPackDraftState`, the
// same answer the pack body's cover and watermark use, so the two cannot
// disagree. Both facts it derives from are stubbed — not left to the mocked
// `sql` — so each case below states which one it is testing. Brightsphere is
// the case that matters: a CLOSED period with NO approved commentary.
const periodStatusMock = vi.fn(async () => 'open' as string);
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: (...a: unknown[]) => periodStatusMock(...a),
}));
const listCommentaryMock = vi.fn(async () => [] as unknown[]);
vi.mock('@/modules/accounting/services/commentary/commentaryService', () => ({
  listCommentary: (...a: unknown[]) => listCommentaryMock(...a),
}));
const renderPackPptxMock = vi.fn(async () => Buffer.from('PK-pptx-bytes'));
vi.mock('@/modules/accounting/services/packs/pptxExportService', () => ({
  renderPackPptx: (...a: unknown[]) => renderPackPptxMock(...a),
}));

import pdfRoute from '../../../pages/api/accounting/packs/[id]/pdf';
import pptxRoute from '../../../pages/api/accounting/packs/[id]/pptx';
import trendRoute from '../../../pages/api/accounting/packs/[id]/trend';
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

  /**
   * A SHAPE IS NOT A DATE, AND AN INVALID ONE USED TO COST 30 SECONDS OF A
   * PROCESS-WIDE, CROSS-TENANT RENDER POOL.
   *
   * `ISO_DATE` matches ten digits in the right places. `2026-02-31` and
   * `2026-13-01` pass it, reach `${from}::date` in the trend query, and
   * Postgres raises 22008 — but only after the renderer has been admitted to
   * one of `withRenderSlot`'s three slots, the print page's own fetch has
   * answered 400, `data-print-ready` has therefore never been set, and
   * `waitForSelector` has run its full `PRINT_READY_TIMEOUT_MS`. The bound is
   * per PROCESS and shared by every tenant, so 25 such requests in 15 minutes
   * — the rate limit — could push other tenants' exports onto the 503 path.
   */
  it.each([
    ['a day that does not exist', '2026-02-31'],
    ['a month that does not exist', '2026-13-01'],
    ['year zero, which Postgres has no calendar for', '0000-01-01'],
  ])('rejects %s before a render slot is spent', async (unused, from) => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from, to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  /** The check `pages.ts` has had all along. A reversed window composes a pack
   *  with no ledger in it, which reads as a dormant company. */
  it('rejects a backwards window rather than rendering an empty pack', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-12-31', to: '2026-01-01' }), res);
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

/**
 * ADVERSARIAL LOW-6: `months` was checked only for finiteness, and
 * `monthSlots` clamps anything outside 1..12 to that range. So `months=999`
 * came back as a twelve-point series a caller had every reason to read as 999
 * months of history, and `months=1.5` as a one-point one — both silently.
 */
describe('GET /api/accounting/packs/[id]/trend — months', () => {
  beforeEach(() => {
    getPackTrendMock.mockClear();
    rateLimitMock.mockClear();
    rateLimitMock.mockResolvedValue(true);
  });

  const call = (months?: string) => {
    const res = mockRes();
    const query: Record<string, string> = { id: 'management', to: '2026-09-05' };
    if (months !== undefined) query.months = months;
    return trendRoute(req(query), res).then(() => res);
  };

  it.each([['0'], ['13'], ['999'], ['1.5'], ['-3'], ['abc'], [''], ['1e1000'], ['NaN']])(
    'rejects months=%j rather than clamping it',
    async (months) => {
      const res = await call(months);
      expect(res.statusCode).toBe(400);
      expect(getPackTrendMock).not.toHaveBeenCalled();
    },
  );

  it('says what it wanted', async () => {
    const res = await call('99');
    expect(JSON.stringify(res.body)).toMatch(/whole number from 1 to 12/);
  });

  it.each([['1'], ['6'], ['12']])('accepts months=%j and passes it through unchanged', async (months) => {
    const res = await call(months);
    expect(res.statusCode).toBe(200);
    expect(getPackTrendMock).toHaveBeenCalledWith(COMPANY, '2026-09-05', Number(months));
  });

  it('defaults to twelve months when the caller says nothing', async () => {
    await call(undefined);
    expect(getPackTrendMock).toHaveBeenCalledWith(COMPANY, '2026-09-05', 12);
  });
});


/**
 * THE FOOTER AND THE METADATA HAD NO CALLER.
 *
 * `buildFooterHtml` and `buildPdfMetadata` were written, reviewed and merged,
 * and `pdf.ts` called `renderPagePdf` without either — so every pack printed
 * Chromium's bare `n / m` and `pdfinfo` reported no metadata at all. The
 * rendered proof is in `tests/unit/print/packSheetCount.test.ts`, which reads
 * the footer off a real printed sheet; this is the wiring, at the call site,
 * because a passing render test proves nothing about a route that never asks
 * for one.
 */
describe('GET /api/accounting/packs/[id]/pdf — running footer and metadata', () => {
  const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;

  beforeEach(() => {
    periodStatusMock.mockResolvedValue('open');
    listCommentaryMock.mockResolvedValue([]);
    rateLimitMock.mockResolvedValue(true);
    sqlMock.mockResolvedValue([{ name: 'Acme Fibre (Pty) Ltd' }]);
    // Without a usable secret the route answers 503 before it ever renders.
    process.env.PRINT_TOKEN_SECRET = 'a'.repeat(32);
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
    else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
  });

  async function render(): Promise<{ footerHtml?: string; metadata?: { title: string; subject: string } }> {
    // Cleared per call: the suites above this one render other packs through
    // the same mock, and reading `calls[0]` would assert against theirs.
    renderPagePdfMock.mockClear();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), mockRes());
    return renderPagePdfMock.mock.calls[0]![0] as never;
  }

  it('names the company, the pack and the period in the footer', async () => {
    const options = await render();
    expect(options.footerHtml).toContain('Acme Fibre (Pty) Ltd');
    expect(options.footerHtml).toContain('Board Pack');
    expect(options.footerHtml).toContain('1 January 2026 to 5 September 2026');
    expect(options.footerHtml).toContain('Confidential');
    // Chromium substitutes these; without them the footer has no page number.
    expect(options.footerHtml).toContain('pageNumber');
    expect(options.footerHtml).toContain('totalPages');
  });

  it('writes the document information dictionary', async () => {
    const options = await render();
    expect(options.metadata?.title).toContain('Acme Fibre (Pty) Ltd');
    expect(options.metadata?.title).toContain('Board Pack');
  });

  const approvedRow = [{ status: 'approved', approvedText: 'The board reviewed these figures.' }];

  it('marks the footer DRAFT while the period is still open', async () => {
    // The same rule the pack body's watermark uses. A footer that said FINAL
    // over figures that can still move is the more dangerous of the two
    // errors, and the two must never disagree on one sheet of paper.
    expect((await render()).footerHtml).toContain('DRAFT');
    expect((await render()).metadata?.subject).toMatch(/draft/i);
  });

  it('marks the footer DRAFT on a CLOSED period whose commentary nobody approved', async () => {
    // Brightsphere, exactly: its period is closed, so the footer said only
    // `Confidential — for board use` and `pdfinfo` reported `Board Pack for
    // …` — over a cover reading "This pack is a DRAFT" and a watermark on
    // every sheet. A pack is read as loose pages; the footer is the line that
    // travels with a forwarded sheet.
    periodStatusMock.mockResolvedValue('closed');
    const options = await render();
    expect(options.footerHtml).toContain('DRAFT');
    expect(options.metadata?.subject).toMatch(/draft/i);
  });

  it('says FINAL only when the period is closed AND commentary is approved', async () => {
    periodStatusMock.mockResolvedValue('closed');
    listCommentaryMock.mockResolvedValue(approvedRow);
    const options = await render();
    expect(options.footerHtml).not.toContain('DRAFT');
    expect(options.metadata?.subject).not.toMatch(/draft/i);
  });

  it('stays DRAFT on an open period even with commentary approved', async () => {
    listCommentaryMock.mockResolvedValue(approvedRow);
    expect((await render()).footerHtml).toContain('DRAFT');
  });

  it('never turns the whole document landscape', async () => {
    // Page 10 alone is landscape, through the named `@page` rule the print
    // CSS keys off `data-print-landscape`. `landscape: true` here would turn
    // all twelve sheets sideways.
    const options = await render() as { landscape?: boolean };
    expect(options.landscape).toBeUndefined();
  });
});
