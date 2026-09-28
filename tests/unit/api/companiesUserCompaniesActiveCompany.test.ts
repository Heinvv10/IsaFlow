/**
 * R-148: GET /api/accounting/companies?action=user-companies reports the
 * company `withAuth` resolved for this request (`req.companyId`, from the
 * `active_company_id` cookie after the membership check), so CompanyProvider
 * can name the company the session actually serves instead of trusting
 * localStorage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ getUserCompanies: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  getUserCompanies: mocks.getUserCompanies,
  getCompany: vi.fn(),
  createCompany: vi.fn(),
  updateCompany: vi.fn(),
  setDefaultCompany: vi.fn(),
}));

import handler from '../../../pages/api/accounting/companies';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const MEMBERSHIPS = [
  { companyId: B, companyName: 'Bravo', role: 'owner', isDefault: true },
  { companyId: A, companyName: 'Alpha', role: 'owner', isDefault: false },
];

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const get = (companyId: string, query: Record<string, string>) =>
  ({ method: 'GET', companyId, companyRole: 'owner', user: { id: 'u1' }, query, body: {} }) as unknown as NextApiRequest;
const body = (res: NextApiResponse) => vi.mocked(res.json).mock.calls[0]?.[0] as { data: Record<string, unknown> };

describe('companies GET user-companies — the session company', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserCompanies.mockResolvedValue(MEMBERSHIPS);
  });

  it('reports the company withAuth resolved for this request, not the default membership', async () => {
    const res = response();
    await handler(get(A, { action: 'user-companies' }), res);
    expect(body(res).data.activeCompanyId).toBe(A);
    expect(body(res).data.items).toEqual(MEMBERSHIPS);
    expect(mocks.getUserCompanies).toHaveBeenCalledWith('u1');
  });

  it('follows the request: a session on B reports B', async () => {
    const res = response();
    await handler(get(B, { action: 'user-companies' }), res);
    expect(body(res).data.activeCompanyId).toBe(B);
  });
});
