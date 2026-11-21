/**
 * GET /api/accounting/month-end-workbench: the payroll card needs Payroll read in the SESSION's company, decided from the
 * database (mayReadPayroll, as withPayrollModule does); without it the service is told not to build it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/payrollReadGate', () => ({ mayReadPayroll: vi.fn() }));
vi.mock('@/modules/accounting/services/workbench/monthEndWorkbenchService', () => ({ getMonthEndWorkbench: vi.fn() }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: { success: vi.fn(), forbidden: vi.fn(), badRequest: vi.fn(), methodNotAllowed: vi.fn() } }));

import { apiResponse } from '@/lib/apiResponse';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/month-end-workbench';

const CO = '11111111-1111-4111-9111-111111111111';
const res = {} as NextApiResponse;
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const req = (over: Record<string, unknown> = {}) => ({ method: 'GET', query: { period: '2026-09' }, companyId: CO, user: { id: 'caller' }, ...over }) as unknown as NextApiRequest;

describe('month-end-workbench payroll card', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(getMonthEndWorkbench).mockResolvedValue({ cards: [] } as never); });

  it.each([[true], [false]])('asks mayReadPayroll for the session company and user and passes payrollRead=%s on', async (allowed) => {
    vi.mocked(mayReadPayroll).mockResolvedValue(allowed);
    await (handler as unknown as Handler)(req(), res);
    expect(mayReadPayroll).toHaveBeenCalledWith(CO, 'caller');
    expect(getMonthEndWorkbench).toHaveBeenCalledWith(CO, '2026-09', { payrollRead: allowed });
  });

  it('ignores a companyId in the query string', async () => {
    vi.mocked(mayReadPayroll).mockResolvedValue(false);
    await (handler as unknown as Handler)(req({ query: { period: '2026-09', companyId: 'other' } }), res);
    expect(mayReadPayroll).toHaveBeenCalledWith(CO, 'caller');
  });

  it('refuses a request with no user in the session, building nothing', async () => {
    await (handler as unknown as Handler)(req({ user: undefined }), res);
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(getMonthEndWorkbench).not.toHaveBeenCalled();
  });
});
