/**
 * #1656 round 7 (breaker M2): both customer-merge routes (customer-merge, and duplicates-merge with entityType=customer) hand the merge a
 * rule-write guard built from Banking Approve. Here the merge is a stand-in that runs that guard for a posting rule being re-pointed, as
 * moveRulesToCustomer does (tests/unit/services/bank/bankRuleMergeGuard.test.ts is the real mover): a non-approver gets 403 and nothing is
 * merged; an approver gets 200.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const merged = vi.hoisted(() => ({ n: 0 }));
const repoint = async (guard: (a: Record<string, unknown>, p: boolean, b: Record<string, unknown>, bp: boolean) => unknown) => {
  const before = { match_pattern: 'ENGEN', client_id: 's', auto_create_entry: true, is_active: true };
  await guard({ ...before, client_id: 't' }, true, before, true);
  merged.n += 1;
};
vi.mock('@/modules/accounting/services/ar/customerMergeService', () => ({
  mergeCustomers: vi.fn(async (_c: string, _s: string, _t: string, _u: string, guard: Parameters<typeof repoint>[0]) => {
    await repoint(guard);
    return { movedDocuments: 1, pausedRecurring: 0, revokedPortalLogins: 0 };
  }),
}));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => false) }));

import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import customerMerge from '../../../pages/api/accounting/customer-merge';
import duplicatesMerge from '../../../pages/api/accounting/duplicates-merge';

const C = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';

function post(handler: unknown, body: Record<string, unknown>) {
  const req = { method: 'POST', query: {}, body, companyId: C, companyRole: 'manager', user: { id: 'u-1' }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}
const ROUTES: Array<[string, unknown, Record<string, unknown>]> = [
  ['customer-merge', customerMerge, { source_id: S, target_id: T }],
  ['duplicates-merge (customer)', duplicatesMerge, { entityType: 'customer', primaryId: T, duplicateId: S }],
];

beforeEach(() => { vi.clearAllMocks(); merged.n = 0; vi.mocked(mayApprove).mockResolvedValue(false); });

describe.each(ROUTES)('%s re-points a posting bank rule', (_name, handler, body) => {
  it('without Banking Approve: 403 and the merge did not complete', async () => {
    const res = await post(handler, body);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    expect(merged.n).toBe(0);
    expect(mayApprove).toHaveBeenCalledWith(C, 'u-1', 'banking');
  });
  it('with Banking Approve: 200', async () => {
    vi.mocked(mayApprove).mockResolvedValue(true);
    const res = await post(handler, body);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(200);
    expect(merged.n).toBe(1);
  });
});
