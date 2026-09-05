/**
 * The two authenticated share-link routes, driven for real with the service
 * mocked.
 *
 * What is actually at stake here is not the happy path — it is that a caller
 * cannot choose the company. Both routes read `companyId` off the request that
 * withAuth built; a body field of the same name must be ignored entirely. The
 * revoke route additionally must not report a distinguishable outcome for an
 * id that belongs to somebody else, so both "not yours" and "does not exist"
 * arrive as the same 404.
 *
 * Mutation check: read companyId from `req.body` in either handler and the
 * corresponding test goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const createMock = vi.fn();
const listMock = vi.fn();
const revokeMock = vi.fn();
const rateLimitMock = vi.fn();
const warnMock = vi.fn();
const infoMock = vi.fn();

// Hoisted: vi.mock factories run before module scope, and the service mock
// below has to hand back this exact class for `instanceof` to mean anything.
const { ShareLinkLimitError } = vi.hoisted(() => ({
  ShareLinkLimitError: class extends Error {
    constructor() { super('cap reached'); this.name = 'ShareLinkLimitError'; }
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: (...a: unknown[]) => infoMock(...a), warn: (...a: unknown[]) => warnMock(...a), error: vi.fn() },
}));
vi.mock('@/lib/rateLimit', () => ({
  checkReportRateLimit: (...a: unknown[]) => rateLimitMock(...a),
}));
// withAuth and withWriteAccess are stubbed — they need a database and a real
// session. withCsrf is NOT: it is the real wrapper, so the tests below run
// through the same double-submit check production runs, and every request
// fixture must carry a matching cookie and header to get past it.
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
  withCsrf: (await vi.importActual<typeof import('@/lib/auth/withCsrf')>('@/lib/auth/withCsrf')).withCsrf,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/share/shareLinkService', () => ({
  createShareLink: (...a: unknown[]) => createMock(...a),
  listShareLinks: (...a: unknown[]) => listMock(...a),
  revokeShareLink: (...a: unknown[]) => revokeMock(...a),
  ShareLinkLimitError,
}));

import linksHandler from '../../../pages/api/accounting/share/links';
import revokeHandler from '../../../pages/api/accounting/share/links/[id]/revoke';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ATTACKER_TARGET = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const PARAMS = { type: 'board', from: '2026-01-01', to: '2026-03-31' };

const CSRF = 'c'.repeat(48);

function mockReqRes(over: Partial<Record<string, unknown>>) {
  const req = {
    method: 'GET',
    query: {},
    body: undefined,
    cookies: { isaflow_csrf: CSRF },
    headers: { 'x-csrf-token': CSRF },
    companyId: COMPANY,
    companyRole: 'admin',
    user: { id: 'user-1', claims: {} },
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

const link = { id: LINK_ID, reportKind: 'pack' as const, params: PARAMS, label: null,
  expiresAt: '2026-04-01T00:00:00.000Z', revokedAt: null, createdBy: 'user-1',
  createdAt: '2026-01-02T09:00:00.000Z', viewCount: 0, lastViewedAt: null };

beforeEach(() => {
  rateLimitMock.mockReset().mockResolvedValue(true);
  warnMock.mockReset();
  infoMock.mockReset();
  createMock.mockReset().mockResolvedValue({ link, token: 'T'.repeat(43) });
  listMock.mockReset().mockResolvedValue([link]);
  revokeMock.mockReset().mockResolvedValue(true);
});

describe('POST /api/accounting/share/links', () => {
  it('takes the company from the session and ignores a body companyId', async () => {
    const { req, res } = mockReqRes({
      method: 'POST',
      body: { params: PARAMS, companyId: ATTACKER_TARGET, company_id: ATTACKER_TARGET },
    });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0]![0] as { companyId: string; params: unknown };
    expect(arg.companyId).toBe(COMPANY);
    expect(JSON.stringify(arg)).not.toContain(ATTACKER_TARGET);
  });

  it('rejects params it cannot parse rather than storing them', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: { type: 'anything', from: 'x', to: 'y' } } });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('passes a numeric ttlDays through and drops a non-numeric one', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS, ttlDays: 400 } });
    await linksHandler(req, res);
    expect((createMock.mock.calls[0]![0] as { ttlDays?: number }).ttlDays).toBe(400);

    createMock.mockClear();
    const second = mockReqRes({ method: 'POST', body: { params: PARAMS, ttlDays: '99999' } });
    await linksHandler(second.req, second.res);
    expect((createMock.mock.calls[0]![0] as { ttlDays?: number }).ttlDays).toBeUndefined();
  });

  it('truncates an over-long label instead of storing it whole', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS, label: 'x'.repeat(500) } });
    await linksHandler(req, res);
    expect((createMock.mock.calls[0]![0] as { label?: string }).label).toHaveLength(120);
  });

  it('returns the token exactly once, on creation', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
    await linksHandler(req, res);
    const payload = res.sent as { data: { token: string; url: string } };
    expect(payload.data.token).toBe('T'.repeat(43));
    expect(payload.data.url).toContain(`/share/${'T'.repeat(43)}`);
  });

  it('builds the url on the production origin, never localhost, when the env var is unset', async () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
      await linksHandler(req, res);
      const payload = res.sent as { data: { url: string } };
      expect(payload.data.url).toBe(`https://app.isaflow.co.za/share/${'T'.repeat(43)}`);
      expect(payload.data.url).not.toContain('localhost');
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });

  it('answers 409 rather than 500 when the company is at its live-link cap', async () => {
    createMock.mockRejectedValue(new ShareLinkLimitError());
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain('cap reached');
  });

  it('lets any other service failure reach the error handler untouched', async () => {
    createMock.mockRejectedValue(new Error('database on fire'));
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
    await expect(linksHandler(req, res)).rejects.toThrow('database on fire');
  });

  it('rate-limits creation per company and never reaches the service', async () => {
    rateLimitMock.mockResolvedValue(false);
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(COMPANY, 'share-link-create');
    expect(createMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });

  it('logs the creation once — in the service, not again in the route', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
    await linksHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(infoMock).not.toHaveBeenCalled();
  });
});

describe('role gate', () => {
  it('refuses a manager the right to mint a link', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS }, companyRole: 'manager' });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a manager the right to revoke one', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { id: LINK_ID }, companyRole: 'manager' });
    await revokeHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('still lets a viewer read the list', async () => {
    const { req, res } = mockReqRes({ method: 'GET', companyRole: 'viewer' });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listMock).toHaveBeenCalledWith(COMPANY);
  });

  it('allows an owner to mint', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS }, companyRole: 'owner' });
    await linksHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/accounting/share/links', () => {
  it('lists only the session company and returns no token', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { companyId: ATTACKER_TARGET } });
    await linksHandler(req, res);

    expect(listMock).toHaveBeenCalledWith(COMPANY);
    const payload = res.sent as { data: { links: unknown[] } };
    expect(payload.data.links).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain('token');
  });

  it('refuses a method it does not serve', async () => {
    const { req, res } = mockReqRes({ method: 'DELETE' });
    await linksHandler(req, res);
    expect(res.statusCode).toBe(405);
    expect(listMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/share/links/[id]/revoke', () => {
  it('revokes with the session company, never a body-supplied one', async () => {
    const { req, res } = mockReqRes({
      method: 'POST', query: { id: LINK_ID }, body: { companyId: ATTACKER_TARGET },
    });
    await revokeHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith(COMPANY, LINK_ID, 'user-1');
  });

  it('answers 404 without querying when the id is not a uuid', async () => {
    for (const id of ['not-a-uuid', "' OR 1=1 --", '', undefined]) {
      const { req, res } = mockReqRes({ method: 'POST', query: { id } });
      await revokeHandler(req, res);
      expect(res.statusCode).toBe(404);
    }
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('answers the same 404 for a link that belongs to another company', async () => {
    revokeMock.mockResolvedValue(false);
    const { req, res } = mockReqRes({ method: 'POST', query: { id: LINK_ID } });
    await revokeHandler(req, res);

    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.sent)).not.toContain(ATTACKER_TARGET);
  });

  it('refuses a GET', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { id: LINK_ID } });
    await revokeHandler(req, res);
    expect(res.statusCode).toBe(405);
    expect(revokeMock).not.toHaveBeenCalled();
  });
});

describe('CSRF', () => {
  it('rejects a create with no CSRF header, before the service is reached', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS }, headers: {} });
    await linksHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects a revoke whose CSRF header does not match the cookie', async () => {
    const { req, res } = mockReqRes({
      method: 'POST', query: { id: LINK_ID }, headers: { 'x-csrf-token': 'd'.repeat(48) },
    });
    await revokeHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('still serves a GET with no CSRF header', async () => {
    const { req, res } = mockReqRes({ method: 'GET', headers: {} });
    await linksHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
