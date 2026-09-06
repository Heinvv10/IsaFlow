/**
 * The three authenticated commentary routes, driven for real with the service
 * mocked.
 *
 * What is at stake: a caller cannot choose the company, cannot name someone
 * else as the approver, cannot approve from a viewer or manager account, and
 * cannot tell "not yours" apart from "does not exist". The empty-draft refusal
 * arrives as a 400 and the already-approved refusal as a 409 — collapsing them
 * would hide a bug behind a retry.
 *
 * Mutation check: read companyId or the approver from `req.body`, or map every
 * failure code to one status, and the matching test goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const listMock = vi.fn();
const generateMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();
const packDataMock = vi.fn();
const rateLimitMock = vi.fn();
const warnMock = vi.fn();

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: (...a: unknown[]) => warnMock(...a), error: vi.fn() },
}));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => rateLimitMock(...a) }));
// withAuth is stubbed — it needs a database and a real session. withCsrf and
// withWriteAccess are the REAL wrappers, so these tests run through the same
// double-submit check and the same role gate production runs.
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
  withCsrf: (await vi.importActual<typeof import('@/lib/auth/withCsrf')>('@/lib/auth/withCsrf')).withCsrf,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/commentary/commentaryService', () => ({
  listCommentary: (...a: unknown[]) => listMock(...a),
  generateDrafts: (...a: unknown[]) => generateMock(...a),
  approveCommentary: (...a: unknown[]) => approveMock(...a),
  rejectCommentary: (...a: unknown[]) => rejectMock(...a),
}));
vi.mock('@/modules/accounting/services/commentary/packData', () => ({
  buildManagementPackData: (...a: unknown[]) => packDataMock(...a),
}));

import indexHandler from '../../../pages/api/accounting/commentary/index';
import approveHandler from '../../../pages/api/accounting/commentary/[id]/approve';
import rejectHandler from '../../../pages/api/accounting/commentary/[id]/reject';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ATTACKER_TARGET = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const PARAMS = { type: 'board', from: '2026-01-01', to: '2026-03-31' };
const CSRF = 'c'.repeat(48);

const row = {
  id: ID, sectionRef: 'income_statement', rowRef: 'revenue',
  draftText: 'Revenue increased by 25.0%.', approvedText: 'Revenue increased by 25.0%.',
  status: 'approved' as const, approvedBy: 'user-1', approvedAt: '2026-04-01T10:00:00.000Z',
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

beforeEach(() => {
  rateLimitMock.mockReset().mockResolvedValue(true);
  warnMock.mockReset();
  listMock.mockReset().mockResolvedValue([row]);
  generateMock.mockReset().mockResolvedValue({ written: 4, skipped: [] });
  approveMock.mockReset().mockResolvedValue({ ok: true, row });
  rejectMock.mockReset().mockResolvedValue({ ok: true, row: { ...row, status: 'rejected' } });
  packDataMock.mockReset().mockResolvedValue({ companyName: 'Britech' });
});

describe('GET /api/accounting/commentary', () => {
  it('lists the session company, ignoring a query companyId', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { ...PARAMS, companyId: ATTACKER_TARGET } });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listMock).toHaveBeenCalledWith(COMPANY, PARAMS);
    expect(JSON.stringify(listMock.mock.calls[0])).not.toContain(ATTACKER_TARGET);
  });

  it('refuses params it cannot parse rather than querying', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { type: 'anything', from: 'x', to: 'y' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('refuses a viewer, without querying — this arm returns unapproved drafts', async () => {
    // withWriteAccess lets every read method through, so nothing gated this arm.
    // What it returns is DRAFT text: sentences about the company's numbers that
    // no named person has signed off.
    const { req, res } = mockReqRes({ method: 'GET', query: PARAMS, companyRole: 'viewer' });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin', 'manager'])('lets %s read', async (companyRole) => {
    const { req, res } = mockReqRes({ method: 'GET', query: PARAMS, companyRole });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('fails closed when the request carries no role at all', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: PARAMS, companyRole: undefined as unknown as string });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/commentary', () => {
  it('generates for the session company and ignores a body companyId', async () => {
    const { req, res } = mockReqRes({
      method: 'POST', body: { params: PARAMS, companyId: ATTACKER_TARGET, userId: 'someone-else' },
    });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(200);
    const arg = generateMock.mock.calls[0]![0] as { companyId: string; userId: string };
    expect(arg.companyId).toBe(COMPANY);
    expect(arg.userId).toBe('user-1');
    expect(JSON.stringify(arg)).not.toContain(ATTACKER_TARGET);
  });

  it('rate-limits generation per company and never builds the pack', async () => {
    rateLimitMock.mockResolvedValue(false);
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS } });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(COMPANY, 'commentary-generate');
    expect(packDataMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });

  it('passes replace only when it was literally true', async () => {
    for (const [value, expected] of [[true, true], ['true', false], [1, false], [undefined, false]] as const) {
      generateMock.mockClear();
      const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS, replace: value } });
      await indexHandler(req, res);
      expect((generateMock.mock.calls[0]![0] as { replace: boolean }).replace).toBe(expected);
    }
  });

  it('refuses a manager the right to regenerate over an approval, before any work', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS, replace: true }, companyRole: 'manager' });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('still lets a manager generate ordinary drafts', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS }, companyRole: 'manager' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('refuses a viewer any write', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS }, companyRole: 'viewer' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses a method it does not serve', async () => {
    const { req, res } = mockReqRes({ method: 'DELETE' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a POST with no CSRF header before the service is reached', async () => {
    const { req, res } = mockReqRes({ method: 'POST', body: { params: PARAMS }, headers: {} });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/commentary/[id]/approve', () => {
  it('approves under the authenticated user and the session company', async () => {
    const { req, res } = mockReqRes({
      method: 'POST', query: { id: ID }, body: { companyId: ATTACKER_TARGET, approvedBy: 'someone-else' },
    });
    await approveHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(approveMock).toHaveBeenCalledWith(COMPANY, ID, 'user-1');
  });

  it('answers 404 without querying when the id is not a uuid', async () => {
    for (const id of ['not-a-uuid', "' OR 1=1 --", '', undefined]) {
      const { req, res } = mockReqRes({ method: 'POST', query: { id } });
      await approveHandler(req, res);
      expect(res.statusCode).toBe(404);
    }
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('answers the same 404 for a row that belongs to another company', async () => {
    approveMock.mockResolvedValue({ ok: false, code: 'not_found', reason: 'Commentary not found.' });
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID } });
    await approveHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('answers 400 for an empty draft and 409 for an already-approved one', async () => {
    approveMock.mockResolvedValue({ ok: false, code: 'empty_draft', reason: 'There is no draft text to approve.' });
    const first = mockReqRes({ method: 'POST', query: { id: ID } });
    await approveHandler(first.req, first.res);
    expect(first.res.statusCode).toBe(400);

    approveMock.mockResolvedValue({ ok: false, code: 'invalid_state', reason: 'Only a draft can be approved.' });
    const second = mockReqRes({ method: 'POST', query: { id: ID } });
    await approveHandler(second.req, second.res);
    expect(second.res.statusCode).toBe(409);
  });

  it('refuses a manager and a viewer, and allows an owner', async () => {
    for (const role of ['manager', 'viewer']) {
      approveMock.mockClear();
      const { req, res } = mockReqRes({ method: 'POST', query: { id: ID }, companyRole: role });
      await approveHandler(req, res);
      expect(res.statusCode).toBe(403);
      expect(approveMock).not.toHaveBeenCalled();
    }
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID }, companyRole: 'owner' });
    await approveHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('refuses a GET and a request with a mismatched CSRF token', async () => {
    const get = mockReqRes({ method: 'GET', query: { id: ID } });
    await approveHandler(get.req, get.res);
    expect(get.res.statusCode).toBe(405);

    const bad = mockReqRes({ method: 'POST', query: { id: ID }, headers: { 'x-csrf-token': 'd'.repeat(48) } });
    await approveHandler(bad.req, bad.res);
    expect(bad.res.statusCode).toBe(403);
    expect(approveMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/commentary/[id]/reject', () => {
  it('rejects with the session company and the authenticated user', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { id: ID }, body: { companyId: ATTACKER_TARGET } });
    await rejectHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(rejectMock).toHaveBeenCalledWith(COMPANY, ID, 'user-1');
  });

  it('lets a manager discard a draft but not a viewer', async () => {
    const manager = mockReqRes({ method: 'POST', query: { id: ID }, companyRole: 'manager' });
    await rejectHandler(manager.req, manager.res);
    expect(manager.res.statusCode).toBe(200);

    rejectMock.mockClear();
    const viewer = mockReqRes({ method: 'POST', query: { id: ID }, companyRole: 'viewer' });
    await rejectHandler(viewer.req, viewer.res);
    expect(viewer.res.statusCode).toBe(403);
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it('maps a stale state to 409 and a foreign id to 404', async () => {
    rejectMock.mockResolvedValue({ ok: false, code: 'invalid_state', reason: 'no longer a draft' });
    const conflict = mockReqRes({ method: 'POST', query: { id: ID } });
    await rejectHandler(conflict.req, conflict.res);
    expect(conflict.res.statusCode).toBe(409);

    rejectMock.mockResolvedValue({ ok: false, code: 'not_found', reason: 'Commentary not found.' });
    const missing = mockReqRes({ method: 'POST', query: { id: ID } });
    await rejectHandler(missing.req, missing.res);
    expect(missing.res.statusCode).toBe(404);
  });
});
