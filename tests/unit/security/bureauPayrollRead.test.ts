/**
 * The bureau cockpit (GET /api/bureau) and the client home (GET /api/bureau/client/[companyId]) list payroll signals with /payroll links.
 * Each client's payroll signals are read only where the caller has Payroll read there (payrollReadByCompany, one query, the admin pool);
 * the others get no payroll query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';

const h = vi.hoisted(() => ({
  pass: (x: unknown) => x, aggregate: vi.fn(), read: vi.fn(), sql: vi.fn(), bureaus: vi.fn(), client: vi.fn(), pool: { query: vi.fn() },
}));
vi.mock('@/lib/auth/withUserAuth', () => ({ withUserAuth: h.pass }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: h.pass }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: { success: vi.fn(), notFound: vi.fn(), badRequest: vi.fn(), methodNotAllowed: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: h.sql }));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({ getPlatformAdminPool: () => h.pool }));
vi.mock('@/modules/accounting/services/workbench/portfolioPayrollAccess', () => ({ payrollReadByCompany: h.read }));
vi.mock('@/modules/bureau/services/bureauWorkAggregatorService', () => ({ aggregateBureauWork: h.aggregate }));
vi.mock('@/modules/bureau/services/bureauService', () => ({ listBureausForUser: h.bureaus, getBureauClientForUser: h.client }));
vi.mock('@/modules/bureau/services/bureauClientTriageService', () => ({ rollupClientTriage: () => [] }));
vi.mock('@/modules/bureau/services/bureauClientMetricsService', () => ({ clientMetricsSnapshot: vi.fn(async () => ({})) }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: pages/ is outside src/
import cockpit from '../../../pages/api/bureau/index';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import clientHome from '../../../pages/api/bureau/client/[companyId]';

const A = '11111111-1111-4111-9111-111111111111';
const B = '22222222-2222-4222-9222-222222222222';
const res = {} as NextApiResponse;
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const req = (over: Record<string, unknown> = {}) => ({ method: 'GET', query: {}, user: { id: 'caller' }, ...over }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.aggregate.mockResolvedValue({ items: [], monthEnd: { closed: 0, total: 0 } });
  h.bureaus.mockResolvedValue([{ id: 'b1' }]);
  h.sql.mockResolvedValue([A, B].map((id) => ({ bureau_id: 'b1', bureau_name: 'Bureau', company_id: id, company_name: id })));
  h.client.mockResolvedValue({ bureau_id: 'b1', bureau_name: 'Bureau', company_id: A, company_name: 'A' });
});

describe('GET /api/bureau', () => {
  it('reads payroll only for the clients where the caller has Payroll read', async () => {
    h.read.mockResolvedValue(new Map([[A, true], [B, false]]));
    await (cockpit as unknown as Handler)(req(), res);
    expect(h.read).toHaveBeenCalledWith(h.pool, 'caller', [A, B]);
    expect(h.aggregate.mock.calls[0]![3]).toEqual({ payrollCompanyIds: [A] });
  });
  it('a client the answer does not mention is not read', async () => {
    h.read.mockResolvedValue(new Map([[A, true]]));
    await (cockpit as unknown as Handler)(req(), res);
    expect(h.aggregate.mock.calls[0]![3]).toEqual({ payrollCompanyIds: [A] });
  });
  it('no Payroll read anywhere: no payroll company', async () => {
    h.read.mockResolvedValue(new Map([[A, false], [B, false]]));
    await (cockpit as unknown as Handler)(req(), res);
    expect(h.aggregate.mock.calls[0]![3]).toEqual({ payrollCompanyIds: [] });
  });
});

describe('GET /api/bureau/client/[companyId]', () => {
  it.each([['not-a-uuid'], ["' OR 1=1 --"], ['11111111-1111-4111-9111'], ['']])('a path id %j is a 404 before any SQL', async (id) => {
    await (clientHome as unknown as Handler)(req({ query: { companyId: id } }), res);
    if (id === '') expect(apiResponse.badRequest).toHaveBeenCalled();
    else expect(apiResponse.notFound).toHaveBeenCalledWith(res, 'Client');
    expect(h.client).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sql).not.toHaveBeenCalled();
    expect(h.aggregate).not.toHaveBeenCalled();
  });

  it.each([[true, [A]], [false, []]])('Payroll read=%s: payroll companies %j', async (allowed, expected) => {
    h.read.mockResolvedValue(new Map([[A, allowed]]));
    await (clientHome as unknown as Handler)(req({ query: { companyId: A } }), res);
    expect(h.read).toHaveBeenCalledWith(h.pool, 'caller', [A]);
    expect(h.aggregate.mock.calls[0]![3]).toEqual({ payrollCompanyIds: expected });
  });
});
