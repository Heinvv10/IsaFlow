/**
 * Audit K-202: GET /api/billing/paystack/mandate/verify settled a Paystack verification onto the company's
 * payment-request and mandate rows on a GET, for any member, with no CSRF check. It is now POST only, behind
 * withCsrf and owner/admin, like mandate/create and mandate/revoke, and reads `ref` from the JSON body.
 * A refused role gets 403 before any query or Paystack call; a GET gets 405; owner and admin reach the
 * live verification. Only withAuth, withErrorHandler, the DB and the billing services are mocked;
 * withWriteAccess and withCsrf are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/billing/services/paystackClient', () => ({ verifyTransaction: vi.fn(async () => ({ status: 'pending' })) }));
vi.mock('@/modules/billing/services/paystackMandateActivation', () => ({
  resolveAuthorisedMandate: vi.fn(async () => null),
  activateAuthorisedMandate: vi.fn(),
  noteAuthorisationNotAttached: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { verifyTransaction } from '@/modules/billing/services/paystackClient';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf';
import verify from '../../../pages/api/billing/paystack/mandate/verify';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const REF = 'auth_111111111111_abcdef012345';
const TOKEN = 'c'.repeat(64);
const REFUSED: Array<string | null | undefined> = ['manager', 'viewer', 'storeman', 'technician', 'system', 'super_admin', null, undefined];
const PENDING_PR = { id: 'pr-1', status: 'pending', paystack_reference: REF, mandate_id: null, failure_reason: null };

function makeRes() {
  const res = {
    statusCode: 200, body: undefined as { data?: { status?: string }; error?: { message?: string } } | undefined,
    setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; },
    json(b: typeof res.body) { res.body = b; return res; },
  };
  return res;
}
interface Opts { body?: unknown; query?: Record<string, string>; csrf?: boolean }
async function call(method: string, companyRole: string | null | undefined, { body = { ref: REF }, query = {}, csrf = true }: Opts = {}) {
  const res = makeRes();
  const req = {
    method, query, body,
    headers: csrf ? { [CSRF_HEADER]: TOKEN } : {}, cookies: csrf ? { [CSRF_COOKIE]: TOKEN } : {},
    companyId: COMPANY, companyRole, user: { id: 'u-1', email: 'u@example.com' },
  } as unknown as NextApiRequest;
  await (verify as unknown as H)(req, res as unknown as NextApiResponse);
  return res;
}
const refusedByGate = (res: ReturnType<typeof makeRes>) =>
  res.statusCode === 403 && /does not allow this action|no company role on request/.test(res.body?.error?.message ?? '');

beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockReset().mockImplementation((async () => []) as never); });

describe('POST /api/billing/paystack/mandate/verify — owner and admin only (K-202)', () => {
  it.each(REFUSED)('role %s gets 403 before any query or Paystack call', async (role) => {
    const res = await call('POST', role);
    expect(refusedByGate(res), `${res.statusCode} ${JSON.stringify(res.body)}`).toBe(true);
    expect(sql).not.toHaveBeenCalled();
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('%s reaches the live Paystack verification of the body ref', async (role) => {
    vi.mocked(sql).mockResolvedValueOnce([PENDING_PR] as never);
    const res = await call('POST', role);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body?.data?.status).toBe('pending');
    expect(verifyTransaction).toHaveBeenCalledWith(REF);
    // The lookup is scoped by the body's ref and the caller's company.
    const lookup = vi.mocked(sql).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(lookup.slice(1)).toEqual([REF, COMPANY]);
  });

  it('an owner POST without the CSRF token is refused before any query', async () => {
    const res = await call('POST', 'owner', { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.body?.error?.message).toBe('CSRF token mismatch');
    expect(sql).not.toHaveBeenCalled();
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it('reads ref from the body only: a query-string ref on POST is a 400', async () => {
    const res = await call('POST', 'owner', { body: {}, query: { ref: REF } });
    expect(res.statusCode).toBe(400);
    expect(sql).not.toHaveBeenCalled();
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it.each([{}, { ref: '' }, { ref: 42 }, { ref: [REF] }, null, 'ref'])('a body of %j is a 400', async (body) => {
    const res = await call('POST', 'owner', { body });
    expect(res.statusCode).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'])('%s is refused with 405 (owner, ref in query and body), no write', async (method) => {
    for (const role of ['owner', 'viewer']) {
      const res = await call(method, role, { query: { ref: REF } });
      expect(res.statusCode === 405 || refusedByGate(res), `${role}: ${res.statusCode}`).toBe(true);
      if (role === 'owner') expect(res.statusCode).toBe(405);
    }
    expect(sql).not.toHaveBeenCalled();
    expect(verifyTransaction).not.toHaveBeenCalled();
  });
});
