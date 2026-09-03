// RED phase — written before implementation
/**
 * GRP-02 — removal of a subsidiary link on consolidation/companies.
 *
 * Authorisation model (deliberately ASYMMETRIC with POST):
 *
 *   POST  requires membership of the CHILD. Linking a child grants the parent
 *         read access to that child's whole GL (consolidation/trial-balance and
 *         consolidation/intercompany-balances aggregate across company_id), so
 *         creating a link must be gated on the tenant whose data is exposed.
 *
 *   DELETE requires membership of the PARENT only, enforced by scoping the
 *         write to `parent_company_id = <the caller's authenticated companyId>`.
 *         `withAuth` already establishes companyId as a company the caller
 *         belongs to, so the scoping IS the membership check, and a caller can
 *         never touch another parent's relationships (that path 404s).
 *
 *         Child membership is deliberately NOT required to remove. Removing a
 *         link strictly REVOKES a cross-tenant read grant, so it must never be
 *         harder than creating one: if child access were required, a link
 *         created in error — or by someone who has since left the child — could
 *         never be withdrawn through the API, and the GL exposure would persist
 *         until someone ran raw SQL. Revocation is fail-open by design.
 *
 * Mutation checks (apply each alone, expect red):
 *  1. Drop the DELETE branch → every test here fails.
 *  2. Pass a hard-coded parent instead of `companyId` to the service
 *     → "scopes the removal to the caller's own company" fails.
 *  3. Return 200 when the service returns false
 *     → "404s when no such relationship exists for this parent" fails.
 *  4. Drop 'DELETE' from the methodNotAllowed list → "advertises DELETE" fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
const createRelMock = vi.fn(async () => undefined);
const deleteRelMock = vi.fn(async () => true);
const getGroupCompaniesMock = vi.fn(async () => [] as unknown[]);

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({
  userBelongsToCompany: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/reports/consolidationService', () => ({
  getGroupCompanies: (...a: unknown[]) => getGroupCompaniesMock(...(a as [])),
  createCompanyRelationship: (...a: unknown[]) => createRelMock(...(a as [])),
  deleteCompanyRelationship: (...a: unknown[]) => deleteRelMock(...(a as [])),
  getConsolidatedTrialBalance: vi.fn(),
  getIntercompanyBalances: vi.fn(),
}));

import handler from '../../../pages/api/accounting/consolidation/companies';

const PARENT = 'company-parent';
const CHILD = 'company-child';
const USER = 'user-1';

function mockReqRes(method: string, opts: { body?: unknown; query?: Record<string, string> } = {}) {
  const req = {
    method,
    query: opts.query ?? {},
    body: opts.body ?? {},
    companyId: PARENT,
    user: { id: USER },
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

describe('DELETE /api/accounting/consolidation/companies', () => {
  beforeEach(() => {
    deleteRelMock.mockClear();
    getGroupCompaniesMock.mockClear();
    deleteRelMock.mockResolvedValue(true);
  });

  it('requires childCompanyId', async () => {
    const { req, res } = mockReqRes('DELETE');
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(deleteRelMock).not.toHaveBeenCalled();
  });

  it("scopes the removal to the caller's own company and records the actor", async () => {
    const { req, res } = mockReqRes('DELETE', { query: { childCompanyId: CHILD } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(deleteRelMock).toHaveBeenCalledTimes(1);
    const args = deleteRelMock.mock.calls[0] as unknown as string[];
    expect(args[0]).toBe(PARENT);
    expect(args[1]).toBe(CHILD);
    expect(args[2]).toBe(USER);
  });

  it('returns the refreshed group list after removal', async () => {
    getGroupCompaniesMock.mockResolvedValueOnce([{ id: PARENT }]);
    const { req, res } = mockReqRes('DELETE', { query: { childCompanyId: CHILD } });
    await handler(req, res);

    expect(getGroupCompaniesMock).toHaveBeenCalledWith(PARENT);
    expect(res.sent).toMatchObject({ data: { items: [{ id: PARENT }] } });
  });

  it('404s when no such relationship exists for this parent', async () => {
    deleteRelMock.mockResolvedValueOnce(false);
    const { req, res } = mockReqRes('DELETE', { query: { childCompanyId: CHILD } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('advertises DELETE in the allowed methods', async () => {
    const { req, res } = mockReqRes('PUT');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(JSON.stringify(res.sent)).toContain('DELETE');
  });
});
