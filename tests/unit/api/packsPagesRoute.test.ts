/**
 * GET /api/accounting/packs/[id]/pages — the board pack document route.
 *
 * The document itself is built for real elsewhere (boardPackDocument.test.ts
 * holds the reads); what is held here is the route's own contract, and the
 * part of it that matters most is that the COMPANY comes from the session.
 * `withAuth` sets `req.companyId`; a route that read a company from the query
 * would hand one tenant's board figures to another with a URL edit and
 * nothing on the page would look wrong.
 *
 * The `id` gate is the other half. `pack=board` is the only pack composed as
 * the twelve-page model; a route that answered for `management` would return
 * a BOARD pack under the management pack's name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from '../services/packs/fixtures/boardPackInputs';

const buildDocumentMock = vi.fn(async () => buildBoardPackPages(demoInput));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const rateLimitMock = vi.fn(async () => true);
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => rateLimitMock(...(a as [])) }));
vi.mock('@/modules/accounting/services/packs/pages/boardPackDocument', () => ({
  buildBoardPackDocument: (...a: unknown[]) => buildDocumentMock(...(a as [])),
}));

import route from '../../../pages/api/accounting/packs/[id]/pages';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function mockRes() {
  const res = {
    statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    end(p: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

function req(query: Record<string, unknown>, method = 'GET') {
  return {
    method, query, url: '/api/accounting/packs/board/pages',
    headers: {}, companyId: COMPANY, user: { id: 'u1', email: 'qa@isaflow.dev' },
  } as unknown as NextApiRequest;
}

const OK_QUERY = { id: 'board', from: '2026-03-01', to: '2026-08-31' };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue(true);
  buildDocumentMock.mockResolvedValue(buildBoardPackPages(demoInput));
});

describe('company scope', () => {
  it('builds the pack for the SESSION company', async () => {
    await route(req(OK_QUERY), mockRes());

    expect(buildDocumentMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }));
  });

  it('ignores a company named in the query — the URL cannot choose a tenant', async () => {
    const attacker = '99999999-9999-4999-8999-999999999999';

    await route(req({ ...OK_QUERY, companyId: attacker, company_id: attacker }), mockRes());

    expect(buildDocumentMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }));
    expect(JSON.stringify(buildDocumentMock.mock.calls[0])).not.toContain(attacker);
  });
});

describe('the id gate', () => {
  it('serves the board pack', async () => {
    const res = mockRes();
    await route(req(OK_QUERY), res);

    expect(res.statusCode).toBe(200);
    expect(buildDocumentMock).toHaveBeenCalledTimes(1);
  });

  it.each([['management'], ['monthly'], ['../admin'], ['BOARD'], ['']])(
    'refuses %j rather than answering with a board pack under another name',
    async (id) => {
      const res = mockRes();
      await route(req({ ...OK_QUERY, id }), res);

      expect(res.statusCode).toBe(400);
      expect(buildDocumentMock).not.toHaveBeenCalled();
    },
  );
});

describe('window validation and method', () => {
  it.each([
    [{ from: '2026-3-1', to: '2026-08-31' }],
    [{ from: '2026-03-01', to: 'yesterday' }],
    [{ from: '', to: '' }],
  ])('refuses a window that is not two ISO dates: %j', async (window) => {
    const res = mockRes();
    await route(req({ ...OK_QUERY, ...window }), res);

    expect(res.statusCode).toBe(400);
    expect(buildDocumentMock).not.toHaveBeenCalled();
  });

  it('refuses a backwards window rather than printing an empty pack', async () => {
    const res = mockRes();
    await route(req({ ...OK_QUERY, from: '2026-08-31', to: '2026-03-01' }), res);

    expect(res.statusCode).toBe(400);
    expect(buildDocumentMock).not.toHaveBeenCalled();
  });

  /**
   * A SHAPE IS NOT A DATE, AND THIS IS A READ PATH WITH NO SAVEPOINT.
   *
   * `2026-02-31` passes the ten-digit regex and reaches `${from}::date`,
   * where Postgres raises 22008 — which aborts the whole request transaction
   * rather than failing one query. `pdf.ts` runs the same check, above the
   * render slot; see `src/lib/validation.ts` for why `Date.parse` is not it
   * (it rolls 31 February forward to 3 March and returns a valid date).
   */
  it.each([
    ['a day that does not exist', '2026-02-31'],
    ['a month that does not exist', '2026-13-01'],
    ['year zero, which Postgres has no calendar for', '0000-01-01'],
  ])('refuses %s before it reaches a ::date cast', async (unused, from) => {
    const res = mockRes();
    await route(req({ ...OK_QUERY, from }), res);

    expect(res.statusCode).toBe(400);
    expect(buildDocumentMock).not.toHaveBeenCalled();
  });

  it('refuses a non-GET', async () => {
    const res = mockRes();
    await route(req(OK_QUERY, 'POST'), res);

    expect(res.statusCode).toBe(405);
    expect(buildDocumentMock).not.toHaveBeenCalled();
  });

  it('refuses when the report rate limit is spent', async () => {
    rateLimitMock.mockResolvedValue(false);
    const res = mockRes();

    await route(req(OK_QUERY), res);

    expect(res.statusCode).toBe(429);
    expect(buildDocumentMock).not.toHaveBeenCalled();
  });
});

describe('the response body', () => {
  it('is the SERIALISED document — charts as plain strings, provenance as figures', async () => {
    const res = mockRes();
    await route(req(OK_QUERY), res);

    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.packType).toBe('board');
    expect((data.pages as unknown[]).length).toBe(12);
    // The class instance would serialise to `{}` and the pack would claim a
    // traceability record it does not carry.
    expect(Array.isArray(data.provenance)).toBe(true);
    expect((data.provenance as unknown[]).length).toBeGreaterThan(50);
  });

  it('survives JSON.stringify with every chart intact', async () => {
    const res = mockRes();
    await route(req(OK_QUERY), res);

    const wire = JSON.parse(JSON.stringify((res.body as { data: unknown }).data)) as {
      pages: Array<{ blocks: Array<{ kind: string; chart?: { svg: string } }> }>;
    };
    const charts = wire.pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'chart');

    expect(charts.length).toBeGreaterThan(0);
    for (const block of charts) expect(block.chart!.svg).toContain('<svg');
  });
});
