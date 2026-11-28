/**
 * Wave 7 EA1 (breaker #1932 L4): the portal's `me` is rate-limited per employee before it reads anything, since its bank
 * line takes a connection on the small migration_admin pool. Refused: 429, no read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ limit: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/employeePortalAuth', () => ({ withEmployeePortalAuth: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: m.limit, INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 } }));
vi.mock('@/modules/accounting/services/payroll/employeePortalDetails', () => ({ readPortalDetails: m.read }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn(), tooManyRequests: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import me from '../../../pages/api/employee-portal/me';

const call = () => (me as unknown as (q: unknown, s: unknown) => Promise<void>)(
  { method: 'GET', employeePortal: { companyId: 'co-A', employeeId: 'emp-1' } }, {} as NextApiResponse);
beforeEach(() => vi.clearAllMocks());

describe('portal me rate limit', () => {
  it('charges the employee\'s own key with the interactive limit, then reads', async () => {
    m.limit.mockResolvedValue(true);
    m.read.mockResolvedValue({ employeeName: 'A' });
    await call();
    expect(m.limit).toHaveBeenCalledWith('co-A', 'employee-portal-me:e:emp-1', { max: 120, windowSecs: 900 });
    expect(m.read).toHaveBeenCalledWith('co-A', 'emp-1');
    expect(apiResponse.success).toHaveBeenCalled();
  });

  it('over the limit: 429 and nothing read', async () => {
    m.limit.mockResolvedValue(false);
    await call();
    expect(apiResponse.tooManyRequests).toHaveBeenCalled();
    expect(m.read).not.toHaveBeenCalled();
  });
});
