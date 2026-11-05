/**
 * Records that name a person take the trusted visitor address (trustedClientIp), not a client-written header: the portal
 * dispute row, and the admin audit rows of platform settings, alert settings and trial extensions (which used to store
 * the raw X-Forwarded-For header whole, a forged chain included). The rate limit on the dispute route stays on getClientIp.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  raiseDispute: vi.fn(async (..._a: unknown[]) => ({ id: 'd1' })),
  logAdminAction: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('@/lib/neon', () => ({ sql: h.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (f: unknown) => f }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (f: unknown) => f }));
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (f: unknown) => f }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '172.71.1.1' }));
vi.mock('@/modules/accounting/services/ar/portalTokenService', () => ({
  hashSessionToken: () => 'hash', verifyInvoicePortalToken: vi.fn(async () => ({ companyId: 'c1', invoiceId: 'i1', status: 'sent' })),
}));
vi.mock('@/modules/accounting/services/ar/disputeService', () => ({ raiseDispute: h.raiseDispute }));
vi.mock('@/modules/admin/services/analyticsService', () => ({ getPlatformSettings: vi.fn(), updatePlatformSettings: vi.fn(async () => undefined) }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: h.logAdminAction }));
vi.mock('@/modules/admin/services/trialService', () => ({ extendTrial: vi.fn(async () => '2030-01-01'), extendTrialsBulk: vi.fn(async () => []), getExpiringTrials: vi.fn(async () => []) }));

import dispute from '../../../pages/api/portal/invoice/[token]/dispute';
import settings from '../../../pages/api/admin/settings';
import alertSettings from '../../../pages/api/admin/alert-settings';
import trials from '../../../pages/api/admin/trials';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const res = () => { const r = { statusCode: 200, status(c: number) { r.statusCode = c; return r; }, json() { return r; }, setHeader() { return r; } }; return r; };
const COMPANY = '11111111-1111-4111-8111-111111111111';
const FORGED = { 'x-forwarded-for': "6.6.6.6'; DROP TABLE x;--, 203.0.113.77, 172.71.1.1" };
const req = (over: Record<string, unknown>) => ({ headers: { ...FORGED }, socket: { remoteAddress: '127.0.0.1' }, user: { id: 'admin-1' }, query: { token: 'a'.repeat(64) }, ...over });

beforeEach(() => { vi.clearAllMocks(); h.sql.mockResolvedValue([]); });

describe('the visitor address in records, not the forged chain', () => {
  it('portal dispute row', async () => {
    await (dispute as Handler)(req({ method: 'POST', body: { reason: 'wrong amount', disputedAmount: 10 } }), res());
    expect(h.raiseDispute).toHaveBeenCalledTimes(1);
    expect(h.raiseDispute.mock.calls[0]![1]).toMatchObject({ ipAddress: '203.0.113.77' });
  });

  it('a forged chain with no valid visitor leaves the dispute without an address, still raised', async () => {
    await (dispute as Handler)(req({ method: 'POST', headers: { 'x-forwarded-for': 'x, 172.71.1.1' }, body: { reason: 'r', disputedAmount: 10 } }), res());
    expect(h.raiseDispute.mock.calls[0]![1]).toMatchObject({ ipAddress: null });
  });

  it.each([
    ['platform settings', settings, { method: 'PATCH', body: {} }],
    ['alert settings', alertSettings, { method: 'PATCH', body: { health_alert_email: 'a@b.co' } }],
  ])('%s audit row', async (_n, route, over) => {
    await (route as Handler)(req(over), res());
    const audit = h.sql.mock.calls.find((c) => (c[0] as readonly string[]).join('?').includes('admin_audit_log'));
    expect(audit, 'an audit insert').toBeTruthy();
    expect(audit!.slice(1)).toContain('203.0.113.77');
    expect(JSON.stringify(audit!.slice(1))).not.toContain('DROP TABLE');
  });

  it('trial extension audit', async () => {
    await (trials as Handler)(req({ method: 'POST', body: { company_id: COMPANY, days: 7 } }), res());
    expect(h.logAdminAction).toHaveBeenCalled();
    expect(h.logAdminAction.mock.calls[0]!.at(-1)).toBe('203.0.113.77');
  });
});
