/**
 * Suspending a company needs a real reason on the server too (WP13 review M1/M2, audit 3.7): the single and the
 * bulk route refuse a missing, empty or whitespace-only reason with 400 and suspend nothing. Bulk used to fall back
 * to a placeholder ("Bulk suspended by admin").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
const suspendCompany = vi.fn(async (_id: string, _reason: string) => true);
vi.mock('@/modules/admin/services/adminCompanyService', () => ({
  suspendCompany: (id: string, reason: string) => suspendCompany(id, reason),
}));
vi.mock('@/modules/admin/services/auditService', () => ({
  logAdminAction: vi.fn(async () => undefined),
  CriticalAuditError: class CriticalAuditError extends Error {},
}));

import suspendRoute from '../../../../pages/api/admin/companies/[id]/suspend';
import bulkRoute from '../../../../pages/api/admin/companies/bulk-action';
import { callRoute } from '../../helpers/adminRouteCall';

const ID = '00000000-0000-4000-8000-0000000c0713';
beforeEach(() => { vi.clearAllMocks(); });

describe('company suspend reason', () => {
  it.each([[{}], [{ reason: '' }], [{ reason: '   ' }]])('single: %j is 400 and suspends nothing', async (body) => {
    const r = await callRoute(suspendRoute, 'POST', { id: ID }, body);
    expect(r.statusCode).toBe(400);
    expect(suspendCompany).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ reason: '' }], [{ reason: '   ' }]])('bulk: %j is 400 and suspends nothing', async (extra) => {
    const r = await callRoute(bulkRoute, 'POST', {}, { action: 'suspend', company_ids: [ID], ...extra });
    expect(r.statusCode).toBe(400);
    expect(suspendCompany).not.toHaveBeenCalled();
  });

  it('single and bulk pass the typed reason, trimmed', async () => {
    expect((await callRoute(suspendRoute, 'POST', { id: ID }, { reason: '  unpaid  ' })).statusCode).toBe(200);
    expect((await callRoute(bulkRoute, 'POST', {}, { action: 'suspend', company_ids: [ID], reason: ' fraud review ' })).statusCode).toBe(200);
    expect(suspendCompany.mock.calls.map((c) => c[1])).toEqual(['unpaid', 'fraud review']);
  });
});
