/**
 * The two authenticated annotation routes, driven for real with the service
 * mocked. Same harness as commentaryRoutes.test.ts: withAuth is stubbed
 * because it needs a database and a session, but withCsrf and withWriteAccess
 * are the REAL wrappers, so these run through the double-submit check and the
 * role gate production runs.
 *
 * What is at stake: a caller cannot choose the company or name a different
 * author, the rate-limit bucket is per USER so one colleague cannot lock the
 * team out, and both writes are bounded — not only the create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const listMock = vi.fn();
const createMock = vi.fn();
const resolveMock = vi.fn();
const authorNameMock = vi.fn();
const rateLimitMock = vi.fn();
const warnMock = vi.fn();

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: (...a: unknown[]) => warnMock(...a), error: vi.fn() },
}));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => rateLimitMock(...a) }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
  withCsrf: (await vi.importActual<typeof import('@/lib/auth/withCsrf')>('@/lib/auth/withCsrf')).withCsrf,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/annotations/annotationService', async () => ({
  listAnnotations: (...a: unknown[]) => listMock(...a),
  createAnnotation: (...a: unknown[]) => createMock(...a),
  resolveAnnotation: (...a: unknown[]) => resolveMock(...a),
  resolveAuthorName: (...a: unknown[]) => authorNameMock(...a),
  MAX_ROW_IDS: 500,
}));

import indexHandler from '../../../pages/api/accounting/annotations/index';
import resolveHandler from '../../../pages/api/accounting/annotations/[id]/resolve';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ATTACKER_TARGET = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const CSRF = 'c'.repeat(48);

const annotation = {
  id: ID, rowId: 'acc:4000', periodStart: '2026-03-01', periodEnd: '2026-08-31',
  body: 'Check the March reversal.', author: 'user-1', authorName: 'Hein van Vuuren',
  createdAt: '2026-09-01T00:00:00.000Z', resolvedAt: null,
};

const POST_BODY = {
  rowId: 'acc:4000', body: 'Check the March reversal.',
  periodStart: '2026-03-01', periodEnd: '2026-08-31',
};

function mockReqRes(over: Partial<Record<string, unknown>>) {
  const req = {
    method: 'GET',
    query: {},
    body: undefined,
    cookies: { isaflow_csrf: CSRF },
    headers: { 'x-csrf-token': CSRF },
    companyId: COMPANY,
    companyRole: 'admin',
    user: { id: 'user-1', email: 'hein@example.co.za', claims: {} },
    ...over,
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => {
  rateLimitMock.mockReset().mockResolvedValue(true);
  warnMock.mockReset();
  listMock.mockReset().mockResolvedValue([annotation]);
  createMock.mockReset().mockResolvedValue(annotation);
  resolveMock.mockReset().mockResolvedValue(true);
  authorNameMock.mockReset().mockResolvedValue('Hein van Vuuren');
});

describe('GET /api/accounting/annotations', () => {
  it('reads the session company, ignoring a query companyId', async () => {
    const { req, res } = mockReqRes({
      method: 'GET',
      query: { rowIds: 'acc:4000,total:grossProfit', from: '2026-03-01', to: '2026-08-31', companyId: ATTACKER_TARGET },
    });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listMock).toHaveBeenCalledWith(COMPANY, ['acc:4000', 'total:grossProfit'], '2026-03-01', '2026-08-31');
    expect(JSON.stringify(listMock.mock.calls[0])).not.toContain(ATTACKER_TARGET);
  });

  it('refuses a date it cannot parse rather than querying', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { rowIds: 'acc:4000', from: '2026-02-31', to: '2026-08-31' } });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('lets a viewer read', async () => {
    const { req, res } = mockReqRes({
      method: 'GET', companyRole: 'viewer',
      query: { rowIds: 'acc:4000', from: '2026-03-01', to: '2026-08-31' },
    });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/accounting/annotations', () => {
  it('files the note under the authenticated user, never a body-supplied author', async () => {
    const { req, res } = mockReqRes({
      method: 'POST',
      body: { ...POST_BODY, author: 'someone-else', companyId: ATTACKER_TARGET, authorName: 'Someone Else' },
    });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(201);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: 'user-1' }));
    expect(JSON.stringify(createMock.mock.calls[0])).not.toContain('someone-else');
    expect(JSON.stringify(createMock.mock.calls[0])).not.toContain('Someone Else');
  });

  it('files it under the looked-up display name rather than the email', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: POST_BODY });
    await indexHandler(req, res);

    expect(authorNameMock).toHaveBeenCalledWith(COMPANY, 'user-1', 'hein@example.co.za');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ authorName: 'Hein van Vuuren' }));
  });

  it('falls back to the email when the lookup finds no name', async () => {
    authorNameMock.mockResolvedValue('hein@example.co.za');
    const { req, res } = mockReqRes({ method: 'POST', body: POST_BODY });
    await indexHandler(req, res);

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ authorName: 'hein@example.co.za' }));
  });

  it('buckets the create rate limit per USER, not per company alone', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: POST_BODY });
    await indexHandler(req, res);

    const [company, bucket] = rateLimitMock.mock.calls[0]!;
    expect(company).toBe(COMPANY);
    expect(bucket).toContain('user-1');
  });

  it('gives two users separate buckets, so one cannot lock the other out', async () => {
    const a = mockReqRes({ method: 'POST', body: POST_BODY });
    await indexHandler(a.req, a.res);
    const b = mockReqRes({ method: 'POST', body: POST_BODY, user: { id: 'user-2', email: 'x@y.z', claims: {} } });
    await indexHandler(b.req, b.res);

    expect(rateLimitMock.mock.calls[0]![1]).not.toBe(rateLimitMock.mock.calls[1]![1]);
  });

  it('refuses over the limit without writing', async () => {
    rateLimitMock.mockResolvedValue(false);
    const { req, res } = mockReqRes({ method: 'POST', body: POST_BODY });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(429);
    expect(createMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });

  it('refuses an empty body and a reversed period without writing', async () => {
    const empty = mockReqRes({ method: 'POST', body: { ...POST_BODY, body: '   ' } });
    await indexHandler(empty.req, empty.res);
    expect(empty.res.statusCode).toBe(400);

    const reversed = mockReqRes({ method: 'POST', body: { ...POST_BODY, periodStart: '2026-08-31', periodEnd: '2026-03-01' } });
    await indexHandler(reversed.req, reversed.res);
    expect(reversed.res.statusCode).toBe(400);

    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a viewer', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: POST_BODY, companyRole: 'viewer' });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a request without the CSRF header', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: POST_BODY, headers: {} });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/annotations/[id]/resolve', () => {
  it('resolves under the session company and the authenticated user', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID, companyId: ATTACKER_TARGET } });
    await resolveHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith(COMPANY, ID, 'user-1');
  });

  it('is rate limited too, per user', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID } });
    await resolveHandler(req, res);

    expect(rateLimitMock).toHaveBeenCalled();
    const [company, bucket] = rateLimitMock.mock.calls[0]!;
    expect(company).toBe(COMPANY);
    expect(bucket).toContain('user-1');
  });

  it('refuses over the limit without writing', async () => {
    rateLimitMock.mockResolvedValue(false);
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID } });
    await resolveHandler(req, res);

    expect(res.statusCode).toBe(429);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a non-uuid id without touching the database', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { id: 'not-a-uuid' } });
    await resolveHandler(req, res);

    expect(res.statusCode).toBe(404);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('answers 404 when the row is not this company or is already resolved', async () => {
    resolveMock.mockResolvedValue(false);
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID } });
    await resolveHandler(req, res);

    expect(res.statusCode).toBe(404);
  });
});
